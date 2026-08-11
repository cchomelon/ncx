use std::collections::HashSet;

use crate::dataset::{DatasetMetadata, VariableSummary, ViewHint};

/// Add conservative display defaults without changing the file's raw metadata.
pub fn add_view_hints(metadata: &mut DatasetMetadata) -> HashSet<String> {
    let mut connectivity_variables = HashSet::new();
    let mut hints = Vec::with_capacity(metadata.variables.len());
    let mut warnings = Vec::new();

    for variable in &metadata.variables {
        match detect_ugrid(variable, metadata) {
            Ok(Some((hint, connectivity))) => {
                connectivity_variables.insert(connectivity);
                hints.push(hint);
            }
            Ok(None) => hints.push(detect_structured(variable, metadata, &mut warnings)),
            Err(warning) => {
                warnings.push(format!("{}: {warning}", variable.path));
                hints.push(ViewHint::Plain);
            }
        }
    }

    for (variable, hint) in metadata.variables.iter_mut().zip(hints) {
        variable.view_hint = hint;
    }
    metadata.warnings.extend(warnings);
    connectivity_variables
}

fn detect_ugrid(
    variable: &VariableSummary,
    metadata: &DatasetMetadata,
) -> Result<Option<(ViewHint, String)>, String> {
    let Some(mesh_reference) = attribute_text(variable, "mesh") else {
        return Ok(None);
    };
    let mesh_path = resolve_reference(&variable.path, mesh_reference);
    let mesh = find_variable(metadata, &mesh_path)
        .ok_or_else(|| format!("mesh attribute refers to missing variable {mesh_path}"))?;
    if attribute_text(mesh, "cf_role") != Some("mesh_topology")
        || attribute_integer(mesh, "topology_dimension") != Some(2)
    {
        return Err(format!("{mesh_path} is not a UGRID 2D mesh topology"));
    }

    let coordinates = attribute_text(mesh, "node_coordinates")
        .ok_or_else(|| format!("{mesh_path} has no node_coordinates"))?
        .split_whitespace()
        .map(|reference| resolve_reference(&mesh.path, reference))
        .collect::<Vec<_>>();
    if coordinates.len() < 2 {
        return Err(format!("{mesh_path} needs two node_coordinates"));
    }
    let (x, y) = order_xy(&coordinates, metadata)
        .unwrap_or_else(|| (coordinates[0].clone(), coordinates[1].clone()));

    let connectivity = attribute_text(mesh, "face_node_connectivity")
        .ok_or_else(|| format!("{mesh_path} has no face_node_connectivity"))?;
    let connectivity = resolve_reference(&mesh.path, connectivity);
    if find_variable(metadata, &connectivity).is_none() {
        return Err(format!(
            "mesh connectivity variable {connectivity} is missing"
        ));
    }
    let location = attribute_text(variable, "location")
        .filter(|location| matches!(*location, "node" | "face"))
        .ok_or_else(|| "UGRID data location must be `node` or `face`".to_owned())?;

    Ok(Some((
        ViewHint::Ugrid2d {
            mesh: mesh_path,
            x,
            y,
            face_node_connectivity: connectivity.clone(),
            location: location.to_owned(),
        },
        connectivity,
    )))
}

fn detect_structured(
    variable: &VariableSummary,
    metadata: &DatasetMetadata,
    warnings: &mut Vec<String>,
) -> ViewHint {
    if variable.dimensions.len() < 2 {
        return ViewHint::Plain;
    }
    let y_dimension = &variable.dimensions[variable.dimensions.len() - 2];
    let x_dimension = &variable.dimensions[variable.dimensions.len() - 1];

    let mut candidates = attribute_text(variable, "coordinates")
        .map(|coordinates| {
            coordinates
                .split_whitespace()
                .map(|reference| resolve_reference(&variable.path, reference))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    candidates.push(x_dimension.path.clone());
    candidates.push(y_dimension.path.clone());
    candidates.sort();
    candidates.dedup();

    let coordinate_variables = candidates
        .iter()
        .filter_map(|path| find_variable(metadata, path))
        .collect::<Vec<_>>();
    let x = coordinate_variables.iter().copied().find(|coordinate| {
        coordinate_axis(coordinate) == Some(Axis::X) || coordinate.path == x_dimension.path
    });
    let y = coordinate_variables.iter().copied().find(|coordinate| {
        coordinate_axis(coordinate) == Some(Axis::Y) || coordinate.path == y_dimension.path
    });

    if let (Some(x), Some(y)) = (x, y) {
        let display_dimensions = [y_dimension.path.as_str(), x_dimension.path.as_str()];
        let x_dimensions = x
            .dimensions
            .iter()
            .map(|dimension| dimension.path.as_str())
            .collect::<Vec<_>>();
        let y_dimensions = y
            .dimensions
            .iter()
            .map(|dimension| dimension.path.as_str())
            .collect::<Vec<_>>();
        if x_dimensions == display_dimensions && y_dimensions == display_dimensions {
            return ViewHint::Curvilinear {
                x: x.path.clone(),
                y: y.path.clone(),
            };
        }
        if x_dimensions == [x_dimension.path.as_str()]
            && y_dimensions == [y_dimension.path.as_str()]
        {
            return ViewHint::Rectilinear {
                x: x.path.clone(),
                y: y.path.clone(),
            };
        }
    }

    if attribute_text(variable, "coordinates").is_some() {
        warnings.push(format!(
            "{}: coordinates do not match its two display dimensions; using index space",
            variable.path
        ));
    }
    ViewHint::Plain
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Axis {
    X,
    Y,
}

fn coordinate_axis(variable: &VariableSummary) -> Option<Axis> {
    match attribute_text(variable, "axis") {
        Some("X" | "x") => return Some(Axis::X),
        Some("Y" | "y") => return Some(Axis::Y),
        _ => {}
    }
    let standard_name = attribute_text(variable, "standard_name").unwrap_or_default();
    if matches!(standard_name, "longitude" | "projection_x_coordinate") {
        return Some(Axis::X);
    }
    if matches!(standard_name, "latitude" | "projection_y_coordinate") {
        return Some(Axis::Y);
    }
    let units = attribute_text(variable, "units").unwrap_or_default();
    if units.starts_with("degrees_east") {
        return Some(Axis::X);
    }
    if units.starts_with("degrees_north") {
        return Some(Axis::Y);
    }
    match variable.name.to_ascii_lowercase().as_str() {
        "x" | "lon" | "longitude" => Some(Axis::X),
        "y" | "lat" | "latitude" => Some(Axis::Y),
        _ => None,
    }
}

fn order_xy(paths: &[String], metadata: &DatasetMetadata) -> Option<(String, String)> {
    let x = paths
        .iter()
        .find(|path| find_variable(metadata, path).and_then(coordinate_axis) == Some(Axis::X))?;
    let y = paths
        .iter()
        .find(|path| find_variable(metadata, path).and_then(coordinate_axis) == Some(Axis::Y))?;
    Some((x.clone(), y.clone()))
}

fn find_variable<'a>(metadata: &'a DatasetMetadata, path: &str) -> Option<&'a VariableSummary> {
    metadata
        .variables
        .iter()
        .find(|variable| variable.path == path)
}

fn attribute_text<'a>(variable: &'a VariableSummary, name: &str) -> Option<&'a str> {
    variable
        .attributes
        .iter()
        .find(|attribute| attribute.name == name)
        .and_then(|attribute| attribute.text())
}

fn attribute_integer(variable: &VariableSummary, name: &str) -> Option<i64> {
    variable
        .attributes
        .iter()
        .find(|attribute| attribute.name == name)
        .and_then(|attribute| attribute.integer())
}

fn resolve_reference(owner_path: &str, reference: &str) -> String {
    let mut parts = if reference.starts_with('/') {
        Vec::new()
    } else {
        owner_path
            .trim_start_matches('/')
            .split('/')
            .collect::<Vec<_>>()
    };
    if !reference.starts_with('/') {
        parts.pop();
    }
    for part in reference.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            name => parts.push(name),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_group_relative_references_without_a_path_library() {
        assert_eq!(
            resolve_reference("/ocean/state/temp", "lon"),
            "/ocean/state/lon"
        );
        assert_eq!(
            resolve_reference("/ocean/state/temp", "../mesh"),
            "/ocean/mesh"
        );
        assert_eq!(
            resolve_reference("/ocean/temp", "/coordinates/lon"),
            "/coordinates/lon"
        );
    }
}
