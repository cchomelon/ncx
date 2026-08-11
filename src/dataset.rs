use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use netcdf::AttributeValue;
use netcdf::types::{FloatType, IntType, NcTypeDescriptor, NcVariableType};
use serde::Serialize;

use crate::NcxResult;
use crate::cf;

const MAX_ATTRIBUTE_VALUES: usize = 256;
const MAX_ATTRIBUTE_TEXT_BYTES: usize = 4096;

#[derive(Clone, Debug, Serialize)]
pub struct DatasetMetadata {
    pub dataset: DatasetSummary,
    pub groups: Vec<GroupSummary>,
    pub dimensions: Vec<DimensionSummary>,
    pub variables: Vec<VariableSummary>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DatasetSummary {
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct GroupSummary {
    pub path: String,
    pub name: String,
    pub attributes: Vec<AttributeSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DimensionSummary {
    pub path: String,
    pub name: String,
    pub length: usize,
    pub unlimited: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct VariableDimension {
    pub path: String,
    pub name: String,
    pub length: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct VariableSummary {
    pub path: String,
    pub name: String,
    pub dtype: String,
    pub dimensions: Vec<VariableDimension>,
    pub attributes: Vec<AttributeSummary>,
    pub view_hint: ViewHint,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewHint {
    Plain,
    Rectilinear {
        x: String,
        y: String,
    },
    Curvilinear {
        x: String,
        y: String,
    },
    Ugrid2d {
        mesh: String,
        x: String,
        y: String,
        face_node_connectivity: String,
        location: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct AttributeSummary {
    pub name: String,
    pub dtype: String,
    pub value: AttributeData,
    #[serde(skip_serializing_if = "is_false")]
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum AttributeData {
    Scalar(AttributeScalar),
    Array(Vec<AttributeScalar>),
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum AttributeScalar {
    Unsigned(u64),
    Signed(i64),
    Float(f64),
    Text(String),
}

impl AttributeSummary {
    pub(crate) fn text(&self) -> Option<&str> {
        match &self.value {
            AttributeData::Scalar(AttributeScalar::Text(value)) => Some(value),
            _ => None,
        }
    }

    pub(crate) fn integer(&self) -> Option<i64> {
        match self.value {
            AttributeData::Scalar(AttributeScalar::Signed(value)) => Some(value),
            AttributeData::Scalar(AttributeScalar::Unsigned(value)) => value.try_into().ok(),
            _ => None,
        }
    }
}

fn is_false(value: &bool) -> bool {
    !value
}

/// The one read-only NetCDF file owned by this ncx process.
pub struct Dataset {
    metadata: DatasetMetadata,
    connectivity_variables: HashSet<String>,
    file: Mutex<netcdf::File>,
}

impl Dataset {
    pub fn open(path: &Path) -> NcxResult<Self> {
        let absolute_path = path
            .canonicalize()
            .map_err(|error| format!("cannot find {}: {error}", path.display()))?;
        let file = netcdf::open(&absolute_path).map_err(|error| {
            format!(
                "cannot open {} as a read-only NetCDF file: {error}",
                absolute_path.display()
            )
        })?;
        let name = absolute_path
            .file_name()
            .unwrap_or(absolute_path.as_os_str())
            .to_string_lossy()
            .into_owned();
        let mut metadata = discover_metadata(&file, name)
            .map_err(|error| format!("cannot inspect {}: {error}", absolute_path.display()))?;
        let connectivity_variables = cf::add_view_hints(&mut metadata);

        Ok(Self {
            metadata,
            connectivity_variables,
            file: Mutex::new(file),
        })
    }

    pub fn metadata(&self) -> &DatasetMetadata {
        &self.metadata
    }

    pub fn read_data(
        &self,
        path: &str,
        selection: &str,
        stride: &str,
        max_response_bytes: u64,
    ) -> Result<DataResponse, DataError> {
        let summary = self
            .metadata
            .variables
            .iter()
            .find(|variable| variable.path == path)
            .ok_or_else(|| DataError::new(404, "variable_not_found", "unknown variable path"))?;
        let selection = ReadSelection::parse(summary, selection, stride)?;
        selection.check_response_size(max_response_bytes)?;

        let file = self.file.lock().map_err(|_| {
            DataError::new(500, "dataset_lock_failed", "the NetCDF reader lock failed")
        })?;
        let variable = file
            .variable(path.trim_start_matches('/'))
            .ok_or_else(|| DataError::new(404, "variable_not_found", "unknown variable path"))?;

        let (dtype, body) = if self.connectivity_variables.contains(path) {
            read_connectivity(&variable, &selection)?
        } else {
            ("f32", read_display_values(&variable, &selection)?)
        };

        Ok(DataResponse {
            dtype,
            shape: selection.output_shape,
            body,
        })
    }
}

pub struct DataResponse {
    pub dtype: &'static str,
    pub shape: Vec<usize>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub struct DataError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub suggested_stride: Option<Vec<usize>>,
}

impl DataError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            suggested_stride: None,
        }
    }

    fn oversized(message: String, suggested_stride: Option<Vec<usize>>) -> Self {
        Self {
            status: 413,
            code: "response_too_large",
            message,
            suggested_stride,
        }
    }
}

fn discover_metadata(file: &netcdf::File, name: String) -> NcxResult<DatasetMetadata> {
    let mut metadata = DatasetMetadata {
        dataset: DatasetSummary { name },
        groups: Vec::new(),
        dimensions: Vec::new(),
        variables: Vec::new(),
        warnings: Vec::new(),
    };
    let dimensions = HashMap::new();

    if let Some(root) = file.root() {
        visit_group(&root, "/", &dimensions, &mut metadata);
    } else {
        visit_classic_root(file, &dimensions, &mut metadata);
    }
    Ok(metadata)
}

fn visit_classic_root(
    file: &netcdf::File,
    inherited_dimensions: &HashMap<String, String>,
    metadata: &mut DatasetMetadata,
) {
    let mut dimensions = inherited_dimensions.clone();
    for dimension in file.dimensions() {
        add_dimension("/", dimension, &mut dimensions, metadata);
    }
    let attributes = collect_attributes(file.attributes(), "/", &mut metadata.warnings);
    metadata.groups.push(GroupSummary {
        path: "/".to_owned(),
        name: "/".to_owned(),
        attributes,
    });
    for variable in file.variables() {
        add_variable("/", variable, &dimensions, metadata);
    }
}

fn visit_group(
    group: &netcdf::Group<'_>,
    path: &str,
    inherited_dimensions: &HashMap<String, String>,
    metadata: &mut DatasetMetadata,
) {
    let mut dimensions = inherited_dimensions.clone();
    for dimension in group.dimensions() {
        add_dimension(path, dimension, &mut dimensions, metadata);
    }
    let attributes = collect_attributes(group.attributes(), path, &mut metadata.warnings);
    metadata.groups.push(GroupSummary {
        path: path.to_owned(),
        name: if path == "/" {
            "/".to_owned()
        } else {
            group.name()
        },
        attributes,
    });
    for variable in group.variables() {
        add_variable(path, variable, &dimensions, metadata);
    }
    for child in group.groups() {
        let child_path = join_path(path, &child.name());
        visit_group(&child, &child_path, &dimensions, metadata);
    }
}

fn add_dimension(
    group_path: &str,
    dimension: netcdf::Dimension<'_>,
    visible_dimensions: &mut HashMap<String, String>,
    metadata: &mut DatasetMetadata,
) {
    let name = dimension.name();
    let path = join_path(group_path, &name);
    visible_dimensions.insert(name.clone(), path.clone());
    metadata.dimensions.push(DimensionSummary {
        path,
        name,
        length: dimension.len(),
        unlimited: dimension.is_unlimited(),
    });
}

fn add_variable(
    group_path: &str,
    variable: netcdf::Variable<'_>,
    visible_dimensions: &HashMap<String, String>,
    metadata: &mut DatasetMetadata,
) {
    let name = variable.name();
    let path = join_path(group_path, &name);
    let dimensions = variable
        .dimensions()
        .iter()
        .map(|dimension| {
            let name = dimension.name();
            let dimension_path = visible_dimensions
                .get(&name)
                .cloned()
                .unwrap_or_else(|| join_path(group_path, &name));
            VariableDimension {
                path: dimension_path,
                name,
                length: dimension.len(),
            }
        })
        .collect();
    let attributes = collect_attributes(variable.attributes(), &path, &mut metadata.warnings);

    metadata.variables.push(VariableSummary {
        path,
        name,
        dtype: data_type_name(&variable.vartype()),
        dimensions,
        attributes,
        view_hint: ViewHint::Plain,
    });
}

fn collect_attributes<'a>(
    attributes: impl Iterator<Item = netcdf::Attribute<'a>>,
    owner: &str,
    warnings: &mut Vec<String>,
) -> Vec<AttributeSummary> {
    attributes
        .filter_map(|attribute| match attribute_summary(&attribute) {
            Ok(summary) => Some(summary),
            Err(error) => {
                warnings.push(format!(
                    "could not read attribute {} on {owner}: {error}",
                    attribute.name()
                ));
                None
            }
        })
        .collect()
}

fn attribute_summary(attribute: &netcdf::Attribute<'_>) -> NcxResult<AttributeSummary> {
    let value = attribute.value().map_err(|error| error.to_string())?;
    let (dtype, value, truncated) = summarize_attribute(value);
    Ok(AttributeSummary {
        name: attribute.name().to_owned(),
        dtype,
        value,
        truncated,
    })
}

fn summarize_attribute(value: AttributeValue) -> (String, AttributeData, bool) {
    match value {
        AttributeValue::Uchar(value) => scalar("u8", AttributeScalar::Unsigned(value.into())),
        AttributeValue::Uchars(values) => unsigned_array("u8", values),
        AttributeValue::Schar(value) => scalar("i8", AttributeScalar::Signed(value.into())),
        AttributeValue::Schars(values) => signed_array("i8", values),
        AttributeValue::Ushort(value) => scalar("u16", AttributeScalar::Unsigned(value.into())),
        AttributeValue::Ushorts(values) => unsigned_array("u16", values),
        AttributeValue::Short(value) => scalar("i16", AttributeScalar::Signed(value.into())),
        AttributeValue::Shorts(values) => signed_array("i16", values),
        AttributeValue::Uint(value) => scalar("u32", AttributeScalar::Unsigned(value.into())),
        AttributeValue::Uints(values) => unsigned_array("u32", values),
        AttributeValue::Int(value) => scalar("i32", AttributeScalar::Signed(value.into())),
        AttributeValue::Ints(values) => signed_array("i32", values),
        AttributeValue::Ulonglong(value) => scalar("u64", AttributeScalar::Unsigned(value)),
        AttributeValue::Ulonglongs(values) => unsigned_array("u64", values),
        AttributeValue::Longlong(value) => scalar("i64", AttributeScalar::Signed(value)),
        AttributeValue::Longlongs(values) => signed_array("i64", values),
        AttributeValue::Float(value) => scalar("f32", float_scalar(value.into())),
        AttributeValue::Floats(values) => float_array("f32", values),
        AttributeValue::Double(value) => scalar("f64", float_scalar(value)),
        AttributeValue::Doubles(values) => float_array("f64", values),
        AttributeValue::Str(value) => {
            let (value, truncated) = truncate_text(value);
            (
                "string".to_owned(),
                AttributeData::Scalar(AttributeScalar::Text(value)),
                truncated,
            )
        }
        AttributeValue::Strs(values) => string_array(values),
    }
}

fn scalar(dtype: &str, value: AttributeScalar) -> (String, AttributeData, bool) {
    (dtype.to_owned(), AttributeData::Scalar(value), false)
}

fn unsigned_array<T>(dtype: &str, values: Vec<T>) -> (String, AttributeData, bool)
where
    T: Into<u64>,
{
    summarize_array(
        dtype,
        values
            .into_iter()
            .map(|value| AttributeScalar::Unsigned(value.into()))
            .collect(),
    )
}

fn signed_array<T>(dtype: &str, values: Vec<T>) -> (String, AttributeData, bool)
where
    T: Into<i64>,
{
    summarize_array(
        dtype,
        values
            .into_iter()
            .map(|value| AttributeScalar::Signed(value.into()))
            .collect(),
    )
}

fn float_array<T>(dtype: &str, values: Vec<T>) -> (String, AttributeData, bool)
where
    T: Into<f64>,
{
    summarize_array(
        dtype,
        values
            .into_iter()
            .map(|value| float_scalar(value.into()))
            .collect(),
    )
}

fn string_array(values: Vec<String>) -> (String, AttributeData, bool) {
    let original_length = values.len();
    let mut truncated = original_length > MAX_ATTRIBUTE_VALUES;
    let values = values
        .into_iter()
        .take(MAX_ATTRIBUTE_VALUES)
        .map(|value| {
            let (value, text_truncated) = truncate_text(value);
            truncated |= text_truncated;
            AttributeScalar::Text(value)
        })
        .collect();
    ("string".to_owned(), AttributeData::Array(values), truncated)
}

fn summarize_array(dtype: &str, mut values: Vec<AttributeScalar>) -> (String, AttributeData, bool) {
    let truncated = values.len() > MAX_ATTRIBUTE_VALUES;
    values.truncate(MAX_ATTRIBUTE_VALUES);
    (dtype.to_owned(), AttributeData::Array(values), truncated)
}

fn float_scalar(value: f64) -> AttributeScalar {
    if value.is_finite() {
        AttributeScalar::Float(value)
    } else if value.is_nan() {
        AttributeScalar::Text("NaN".to_owned())
    } else if value.is_sign_positive() {
        AttributeScalar::Text("Infinity".to_owned())
    } else {
        AttributeScalar::Text("-Infinity".to_owned())
    }
}

fn truncate_text(mut value: String) -> (String, bool) {
    if value.len() <= MAX_ATTRIBUTE_TEXT_BYTES {
        return (value, false);
    }
    let mut end = MAX_ATTRIBUTE_TEXT_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    (value, true)
}

fn data_type_name(data_type: &NcVariableType) -> String {
    match data_type {
        NcVariableType::Int(IntType::U8) => "u8".to_owned(),
        NcVariableType::Int(IntType::U16) => "u16".to_owned(),
        NcVariableType::Int(IntType::U32) => "u32".to_owned(),
        NcVariableType::Int(IntType::U64) => "u64".to_owned(),
        NcVariableType::Int(IntType::I8) => "i8".to_owned(),
        NcVariableType::Int(IntType::I16) => "i16".to_owned(),
        NcVariableType::Int(IntType::I32) => "i32".to_owned(),
        NcVariableType::Int(IntType::I64) => "i64".to_owned(),
        NcVariableType::Float(FloatType::F32) => "f32".to_owned(),
        NcVariableType::Float(FloatType::F64) => "f64".to_owned(),
        NcVariableType::Char => "char".to_owned(),
        NcVariableType::String => "string".to_owned(),
        NcVariableType::Enum(value) => format!("enum {}", value.name),
        NcVariableType::Opaque(value) => format!("opaque {}", value.name),
        NcVariableType::Compound(value) => format!("compound {}", value.name),
        NcVariableType::Vlen(value) => format!("vlen {}", value.name),
    }
}

fn join_path(group_path: &str, name: &str) -> String {
    if group_path == "/" {
        format!("/{name}")
    } else {
        format!("{group_path}/{name}")
    }
}

#[derive(Debug)]
struct ReadSelection {
    start: Vec<usize>,
    count: Vec<usize>,
    stride: Vec<isize>,
    requested_stride: Vec<usize>,
    output_shape: Vec<usize>,
    ranged_dimensions: Vec<bool>,
    elements: usize,
}

impl ReadSelection {
    fn parse(variable: &VariableSummary, selection: &str, stride: &str) -> Result<Self, DataError> {
        let rank = variable.dimensions.len();
        let selections = comma_separated(selection, rank, "selection")?;
        let strides = comma_separated(stride, rank, "stride")?
            .into_iter()
            .map(|value| {
                value.parse::<usize>().map_err(|_| {
                    DataError::new(400, "invalid_stride", format!("invalid stride {value:?}"))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut start = Vec::with_capacity(rank);
        let mut count = Vec::with_capacity(rank);
        let mut netcdf_stride = Vec::with_capacity(rank);
        let mut output_shape = Vec::with_capacity(rank);
        let mut ranged_dimensions = Vec::with_capacity(rank);
        let mut elements = 1_usize;

        for (dimension_index, ((item, stride), dimension)) in selections
            .into_iter()
            .zip(strides.iter().copied())
            .zip(&variable.dimensions)
            .enumerate()
        {
            if stride == 0 || stride > isize::MAX as usize {
                return Err(DataError::new(
                    400,
                    "invalid_stride",
                    format!(
                        "stride for dimension {} must be a positive integer",
                        dimension.name
                    ),
                ));
            }
            if item.contains(':') {
                let (range_start, range_stop) = parse_range(item, dimension)?;
                let selected = 1 + (range_stop - range_start - 1) / stride;
                start.push(range_start);
                count.push(selected);
                netcdf_stride.push(stride as isize);
                output_shape.push(selected);
                ranged_dimensions.push(true);
                elements = elements.checked_mul(selected).ok_or_else(|| {
                    DataError::new(413, "response_too_large", "selection size overflows usize")
                })?;
            } else {
                if stride != 1 {
                    return Err(DataError::new(
                        400,
                        "invalid_stride",
                        format!("indexed dimension {} must have stride 1", dimension.name),
                    ));
                }
                let index = item.parse::<usize>().map_err(|_| {
                    DataError::new(
                        400,
                        "invalid_selection",
                        format!("invalid index {item:?} for dimension {}", dimension.name),
                    )
                })?;
                if index >= dimension.length {
                    return Err(DataError::new(
                        400,
                        "selection_out_of_bounds",
                        format!(
                            "dimension {} has length {}; index {} is invalid",
                            dimension.name, dimension.length, index
                        ),
                    ));
                }
                start.push(index);
                count.push(1);
                netcdf_stride.push(1);
                ranged_dimensions.push(false);
            }

            debug_assert_eq!(start.len(), dimension_index + 1);
        }

        Ok(Self {
            start,
            count,
            stride: netcdf_stride,
            requested_stride: strides,
            output_shape,
            ranged_dimensions,
            elements,
        })
    }

    fn check_response_size(&self, maximum: u64) -> Result<(), DataError> {
        let bytes = u64::try_from(self.elements)
            .ok()
            .and_then(|elements| elements.checked_mul(4))
            .ok_or_else(|| DataError::oversized("response size overflows u64".to_owned(), None))?;
        if bytes <= maximum {
            return Ok(());
        }

        let suggested_stride = self.suggested_stride(maximum);
        let suggestion = suggested_stride
            .as_ref()
            .map(|values| {
                values
                    .iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .map(|values| format!("; try stride={values}"))
            .unwrap_or_default();
        Err(DataError::oversized(
            format!("response would be {bytes} bytes; limit is {maximum}{suggestion}"),
            suggested_stride,
        ))
    }

    fn suggested_stride(&self, maximum: u64) -> Option<Vec<usize>> {
        let budget = usize::try_from(maximum / 4).ok()?;
        if budget == 0 || !self.ranged_dimensions.contains(&true) {
            return None;
        }

        // A power-of-two suggestion is conservative, easy to explain, and
        // guaranteed to fit without inventing a general request planner.
        let mut factor = 2_usize;
        loop {
            let elements = self.count.iter().zip(&self.ranged_dimensions).try_fold(
                1_usize,
                |total, (&count, &ranged)| {
                    total.checked_mul(if ranged { count.div_ceil(factor) } else { 1 })
                },
            )?;
            if elements <= budget {
                break;
            }
            factor = factor.checked_mul(2)?;
        }

        let mut suggestion = self.requested_stride.clone();
        for (stride, ranged) in suggestion.iter_mut().zip(&self.ranged_dimensions) {
            if *ranged {
                *stride = stride.checked_mul(factor)?;
            }
        }
        Some(suggestion)
    }
}

fn comma_separated<'a>(
    value: &'a str,
    rank: usize,
    field: &str,
) -> Result<Vec<&'a str>, DataError> {
    let values = if rank == 0 && value.is_empty() {
        Vec::new()
    } else {
        value.split(',').map(str::trim).collect()
    };
    if values.len() != rank {
        return Err(DataError::new(
            400,
            "rank_mismatch",
            format!(
                "{field} has {} items; variable rank is {rank}",
                values.len()
            ),
        ));
    }
    Ok(values)
}

fn parse_range(item: &str, dimension: &VariableDimension) -> Result<(usize, usize), DataError> {
    let (start, stop) = item.split_once(':').ok_or_else(|| {
        DataError::new(400, "invalid_selection", format!("invalid range {item:?}"))
    })?;
    if stop.contains(':') {
        return Err(DataError::new(
            400,
            "invalid_selection",
            format!("invalid range {item:?}"),
        ));
    }
    let start = if start.is_empty() {
        0
    } else {
        start.parse().map_err(|_| {
            DataError::new(400, "invalid_selection", format!("invalid range {item:?}"))
        })?
    };
    let stop = if stop.is_empty() {
        dimension.length
    } else {
        stop.parse().map_err(|_| {
            DataError::new(400, "invalid_selection", format!("invalid range {item:?}"))
        })?
    };
    if start >= stop || stop > dimension.length {
        return Err(DataError::new(
            400,
            "selection_out_of_bounds",
            format!(
                "dimension {} has length {}; range {}:{} is invalid",
                dimension.name, dimension.length, start, stop
            ),
        ));
    }
    Ok((start, stop))
}

fn read_display_values(
    variable: &netcdf::Variable<'_>,
    selection: &ReadSelection,
) -> Result<Vec<u8>, DataError> {
    match variable.vartype() {
        NcVariableType::Int(IntType::U8) => read_numeric::<u8>(variable, selection),
        NcVariableType::Int(IntType::U16) => read_numeric::<u16>(variable, selection),
        NcVariableType::Int(IntType::U32) => read_numeric::<u32>(variable, selection),
        NcVariableType::Int(IntType::U64) => read_numeric::<u64>(variable, selection),
        NcVariableType::Int(IntType::I8) => read_numeric::<i8>(variable, selection),
        NcVariableType::Int(IntType::I16) => read_numeric::<i16>(variable, selection),
        NcVariableType::Int(IntType::I32) => read_numeric::<i32>(variable, selection),
        NcVariableType::Int(IntType::I64) => read_numeric::<i64>(variable, selection),
        NcVariableType::Float(FloatType::F32) => read_numeric::<f32>(variable, selection),
        NcVariableType::Float(FloatType::F64) => read_numeric::<f64>(variable, selection),
        _ => Err(DataError::new(
            422,
            "unsupported_dtype",
            "only primitive numeric variables can be displayed",
        )),
    }
}

fn read_numeric<T>(
    variable: &netcdf::Variable<'_>,
    selection: &ReadSelection,
) -> Result<Vec<u8>, DataError>
where
    T: PackedNumber,
{
    let extents = (
        selection.start.as_slice(),
        selection.count.as_slice(),
        selection.stride.as_slice(),
    );
    let values = variable
        .get_values::<T, _>(extents)
        .map_err(|error| DataError::new(500, "netcdf_read_failed", error.to_string()))?;
    let missing = missing_values::<T>(variable)?;
    let scale = numeric_attribute(variable, "scale_factor")?.unwrap_or(1.0);
    let offset = numeric_attribute(variable, "add_offset")?.unwrap_or(0.0);
    if !scale.is_finite() || !offset.is_finite() {
        return Err(DataError::new(
            422,
            "invalid_packing",
            "scale_factor and add_offset must be finite",
        ));
    }

    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        let display = if missing.contains(&value) {
            f32::NAN
        } else {
            let unpacked = value.to_f64() * scale + offset;
            let display = unpacked as f32;
            if display.is_finite() {
                display
            } else {
                f32::NAN
            }
        };
        bytes.extend_from_slice(&display.to_le_bytes());
    }
    Ok(bytes)
}

fn missing_values<T>(variable: &netcdf::Variable<'_>) -> Result<Vec<T>, DataError>
where
    T: PackedNumber,
{
    let mut missing = variable
        .fill_value::<T>()
        .map_err(|error| DataError::new(422, "invalid_fill_value", error.to_string()))?
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(attribute) = variable.attribute("missing_value") {
        let value = attribute
            .value()
            .map_err(|error| DataError::new(422, "invalid_missing_value", error.to_string()))?;
        let values = T::from_attribute(value).ok_or_else(|| {
            DataError::new(
                422,
                "invalid_missing_value",
                "missing_value does not match the variable's stored type",
            )
        })?;
        missing.extend(values);
    }
    Ok(missing)
}

fn numeric_attribute(
    variable: &netcdf::Variable<'_>,
    name: &str,
) -> Result<Option<f64>, DataError> {
    let Some(attribute) = variable.attribute(name) else {
        return Ok(None);
    };
    let value = attribute
        .value()
        .map_err(|error| DataError::new(422, "invalid_packing", error.to_string()))?;
    let number = match value {
        AttributeValue::Uchar(value) => value.into(),
        AttributeValue::Schar(value) => value.into(),
        AttributeValue::Ushort(value) => value.into(),
        AttributeValue::Short(value) => value.into(),
        AttributeValue::Uint(value) => value.into(),
        AttributeValue::Int(value) => value.into(),
        AttributeValue::Ulonglong(value) => value as f64,
        AttributeValue::Longlong(value) => value as f64,
        AttributeValue::Float(value) => value.into(),
        AttributeValue::Double(value) => value,
        _ => {
            return Err(DataError::new(
                422,
                "invalid_packing",
                format!("{name} must be one numeric scalar"),
            ));
        }
    };
    Ok(Some(number))
}

trait PackedNumber: NcTypeDescriptor + Copy + PartialEq + Send + 'static {
    fn to_f64(self) -> f64;
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>>;
}

impl PackedNumber for u8 {
    fn to_f64(self) -> f64 {
        self.into()
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Uchar(value) => Some(vec![value]),
            AttributeValue::Uchars(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for u16 {
    fn to_f64(self) -> f64 {
        self.into()
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Ushort(value) => Some(vec![value]),
            AttributeValue::Ushorts(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for u32 {
    fn to_f64(self) -> f64 {
        self.into()
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Uint(value) => Some(vec![value]),
            AttributeValue::Uints(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for u64 {
    fn to_f64(self) -> f64 {
        self as f64
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Ulonglong(value) => Some(vec![value]),
            AttributeValue::Ulonglongs(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for i8 {
    fn to_f64(self) -> f64 {
        self.into()
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Schar(value) => Some(vec![value]),
            AttributeValue::Schars(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for i16 {
    fn to_f64(self) -> f64 {
        self.into()
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Short(value) => Some(vec![value]),
            AttributeValue::Shorts(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for i32 {
    fn to_f64(self) -> f64 {
        self.into()
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Int(value) => Some(vec![value]),
            AttributeValue::Ints(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for i64 {
    fn to_f64(self) -> f64 {
        self as f64
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Longlong(value) => Some(vec![value]),
            AttributeValue::Longlongs(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for f32 {
    fn to_f64(self) -> f64 {
        self.into()
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Float(value) => Some(vec![value]),
            AttributeValue::Floats(values) => Some(values),
            _ => None,
        }
    }
}

impl PackedNumber for f64 {
    fn to_f64(self) -> f64 {
        self
    }
    fn from_attribute(value: AttributeValue) -> Option<Vec<Self>> {
        match value {
            AttributeValue::Double(value) => Some(vec![value]),
            AttributeValue::Doubles(values) => Some(values),
            _ => None,
        }
    }
}

fn read_connectivity(
    variable: &netcdf::Variable<'_>,
    selection: &ReadSelection,
) -> Result<(&'static str, Vec<u8>), DataError> {
    match variable.vartype() {
        NcVariableType::Int(IntType::U8) => read_unsigned_connectivity::<u8>(variable, selection),
        NcVariableType::Int(IntType::U16) => read_unsigned_connectivity::<u16>(variable, selection),
        NcVariableType::Int(IntType::U32) => read_unsigned_connectivity::<u32>(variable, selection),
        NcVariableType::Int(IntType::U64) => read_unsigned_connectivity::<u64>(variable, selection),
        NcVariableType::Int(IntType::I8) => read_signed_connectivity::<i8>(variable, selection),
        NcVariableType::Int(IntType::I16) => read_signed_connectivity::<i16>(variable, selection),
        NcVariableType::Int(IntType::I32) => read_signed_connectivity::<i32>(variable, selection),
        NcVariableType::Int(IntType::I64) => read_signed_connectivity::<i64>(variable, selection),
        _ => Err(DataError::new(
            422,
            "unsupported_connectivity",
            "UGRID connectivity must use a primitive integer type",
        )),
    }
}

fn read_unsigned_connectivity<T>(
    variable: &netcdf::Variable<'_>,
    selection: &ReadSelection,
) -> Result<(&'static str, Vec<u8>), DataError>
where
    T: NcTypeDescriptor + Copy + Into<u64>,
{
    let values = read_values::<T>(variable, selection)?;
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        let value = u32::try_from(value.into()).map_err(|_| {
            DataError::new(
                422,
                "unsupported_connectivity",
                "connectivity value does not fit in u32",
            )
        })?;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(("u32", bytes))
}

fn read_signed_connectivity<T>(
    variable: &netcdf::Variable<'_>,
    selection: &ReadSelection,
) -> Result<(&'static str, Vec<u8>), DataError>
where
    T: NcTypeDescriptor + Copy + Into<i64>,
{
    let values = read_values::<T>(variable, selection)?;
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        let value = i32::try_from(value.into()).map_err(|_| {
            DataError::new(
                422,
                "unsupported_connectivity",
                "connectivity value does not fit in i32",
            )
        })?;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(("i32", bytes))
}

fn read_values<T>(
    variable: &netcdf::Variable<'_>,
    selection: &ReadSelection,
) -> Result<Vec<T>, DataError>
where
    T: NcTypeDescriptor + Copy,
{
    variable
        .get_values::<T, _>((
            selection.start.as_slice(),
            selection.count.as_slice(),
            selection.stride.as_slice(),
        ))
        .map_err(|error| DataError::new(500, "netcdf_read_failed", error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_variable() -> VariableSummary {
        VariableSummary {
            path: "/temperature".to_owned(),
            name: "temperature".to_owned(),
            dtype: "i16".to_owned(),
            dimensions: vec![
                VariableDimension {
                    path: "/y".to_owned(),
                    name: "y".to_owned(),
                    length: 2,
                },
                VariableDimension {
                    path: "/x".to_owned(),
                    name: "x".to_owned(),
                    length: 4,
                },
            ],
            attributes: Vec::new(),
            view_hint: ViewHint::Plain,
        }
    }

    #[test]
    fn validates_ranges_indices_and_strides_before_reading() {
        let variable = test_variable();
        let selection = ReadSelection::parse(&variable, "1,0:4", "1,2").unwrap();
        assert_eq!(selection.start, [1, 0]);
        assert_eq!(selection.count, [1, 2]);
        assert_eq!(selection.output_shape, [2]);

        let error = ReadSelection::parse(&variable, "2,:", "1,1").unwrap_err();
        assert_eq!(error.code, "selection_out_of_bounds");
        let error = ReadSelection::parse(&variable, ":,:", "0,1").unwrap_err();
        assert_eq!(error.code, "invalid_stride");

        let selection = ReadSelection::parse(&variable, ":,:", "1,1").unwrap();
        let error = selection.check_response_size(16).unwrap_err();
        let suggestion = error.suggested_stride.unwrap();
        let suggestion = suggestion
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let suggested_selection = ReadSelection::parse(&variable, ":,:", &suggestion).unwrap();
        assert!(suggested_selection.check_response_size(16).is_ok());
    }

    #[test]
    fn discovers_and_decodes_a_packed_rectilinear_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ncx-{unique}.nc"));
        {
            let mut file = netcdf::create(&path).unwrap();
            file.add_dimension("y", 2).unwrap();
            file.add_dimension("x", 4).unwrap();
            {
                let mut y = file.add_variable::<f32>("y", &["y"]).unwrap();
                y.put_attribute("axis", "Y").unwrap();
                y.put_values(&[23.0, 24.0], ..).unwrap();
            }
            {
                let mut x = file.add_variable::<f32>("x", &["x"]).unwrap();
                x.put_attribute("axis", "X").unwrap();
                x.put_values(&[110.0, 111.0, 112.0, 113.0], ..).unwrap();
            }
            {
                let mut temperature = file
                    .add_variable::<i16>("temperature", &["y", "x"])
                    .unwrap();
                temperature.put_attribute("_FillValue", -9999_i16).unwrap();
                temperature.put_attribute("scale_factor", 0.5_f32).unwrap();
                temperature.put_attribute("add_offset", 270.0_f32).unwrap();
                temperature
                    .put_values(&[0, 10, -9999, 30, 40, 50, 60, 70], ..)
                    .unwrap();
            }
        }

        let dataset = Dataset::open(&path).unwrap();
        let temperature = dataset
            .metadata()
            .variables
            .iter()
            .find(|variable| variable.path == "/temperature")
            .unwrap();
        assert!(matches!(
            temperature.view_hint,
            ViewHint::Rectilinear { .. }
        ));

        let response = dataset
            .read_data("/temperature", ":,:", "1,2", 1024)
            .unwrap();
        assert_eq!(response.shape, [2, 2]);
        let values = response
            .body
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(values[0], 270.0);
        assert!(values[1].is_nan());
        assert_eq!(values[2..], [290.0, 300.0]);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn discovers_curvilinear_and_ugrid_fixtures() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
        let curvilinear = Dataset::open(&fixtures.join("curvilinear.nc")).unwrap();
        let sea_temperature = curvilinear
            .metadata()
            .variables
            .iter()
            .find(|variable| variable.path == "/sea_temperature")
            .unwrap();
        assert!(matches!(
            sea_temperature.view_hint,
            ViewHint::Curvilinear { .. }
        ));

        let ugrid = Dataset::open(&fixtures.join("ugrid.nc")).unwrap();
        let node_temperature = ugrid
            .metadata()
            .variables
            .iter()
            .find(|variable| variable.path == "/node_temperature")
            .unwrap();
        assert!(matches!(
            &node_temperature.view_hint,
            ViewHint::Ugrid2d { location, .. } if location == "node"
        ));
        let face_depth = ugrid
            .metadata()
            .variables
            .iter()
            .find(|variable| variable.path == "/face_depth")
            .unwrap();
        assert!(matches!(
            &face_depth.view_hint,
            ViewHint::Ugrid2d { location, .. } if location == "face"
        ));

        let connectivity = ugrid.read_data("/face_nodes", ":,:", "1,1", 1024).unwrap();
        assert_eq!(connectivity.dtype, "i32");
        assert_eq!(connectivity.shape, [3, 4]);
        assert_eq!(
            i32::from_le_bytes(connectivity.body[12..16].try_into().unwrap()),
            -1
        );
    }

    #[test]
    fn discovers_classic_files_and_scoped_group_dimensions() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
        let classic = Dataset::open(&fixtures.join("classic.nc")).unwrap();
        assert_eq!(classic.metadata().groups.len(), 1);
        let values = classic.read_data("/value", ":,:", "1,2", 1024).unwrap();
        assert_eq!(values.shape, [2, 2]);

        let groups = Dataset::open(&fixtures.join("groups.nc")).unwrap();
        assert!(
            groups
                .metadata()
                .groups
                .iter()
                .any(|group| group.path == "/east")
        );
        assert!(
            groups
                .metadata()
                .groups
                .iter()
                .any(|group| group.path == "/west")
        );
        assert!(
            groups
                .metadata()
                .dimensions
                .iter()
                .any(|dimension| { dimension.path == "/east/x" && dimension.length == 2 })
        );
        assert!(
            groups
                .metadata()
                .dimensions
                .iter()
                .any(|dimension| { dimension.path == "/west/x" && dimension.length == 3 })
        );
        let east = groups
            .metadata()
            .variables
            .iter()
            .find(|variable| variable.path == "/east/temperature")
            .unwrap();
        assert!(matches!(
            &east.view_hint,
            ViewHint::Rectilinear { x, y } if x == "/east/x" && y == "/east/y"
        ));
        let values = groups
            .read_data("/west/temperature", ":,:", "1,1", 1024)
            .unwrap();
        assert_eq!(values.shape, [2, 3]);
    }
}
