import { formatNumber } from "./color.ts";
import type { Metadata, Probe, Variable, VariableDimension } from "./model.ts";
import { attributeText, resolveVariableReference } from "./model.ts";

export interface GeographicPosition {
  latitude: number;
  longitude: number;
}

export function geographicCoordinateVariables(
  metadata: Metadata,
  variable: Variable,
  dimensions: readonly VariableDimension[],
): { longitude: Variable; latitude: Variable } | undefined {
  const referencedPaths = (attributeText(variable, "coordinates") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((reference) => resolveVariableReference(variable.path, reference));
  const referenced = referencedPaths
    .map((path) => metadata.variables.find((candidate) => candidate.path === path))
    .filter((candidate): candidate is Variable => candidate !== undefined);
  const candidates = [
    ...referenced,
    ...metadata.variables.filter((candidate) => !referencedPaths.includes(candidate.path)),
  ];
  const sameDimensions = (candidate: Variable) =>
    candidate.dimensions.length === dimensions.length &&
    candidate.dimensions.every((dimension, index) => dimension.path === dimensions[index]?.path);
  const longitude = candidates.find((candidate) => sameDimensions(candidate) && isLongitude(candidate));
  const latitude = candidates.find((candidate) => sameDimensions(candidate) && isLatitude(candidate));
  return longitude && latitude ? { longitude, latitude } : undefined;
}

export function geographicPosition(
  metadata: Metadata,
  variable: Variable,
  x: number,
  y: number,
): GeographicPosition | undefined {
  const hint = variable.view_hint;
  if (hint.kind === "rectilinear" || hint.kind === "curvilinear" || hint.kind === "ugrid2d") {
    const xCoordinate = metadata.variables.find((candidate) => candidate.path === hint.x);
    const yCoordinate = metadata.variables.find((candidate) => candidate.path === hint.y);
    if (xCoordinate && yCoordinate && isLongitude(xCoordinate) && isLatitude(yCoordinate)) {
      return { latitude: y, longitude: x };
    }
  }

  const projection = metadata.groups
    .find((group) => group.path === "/")
    ?.attributes.find((attribute) => attribute.name === "projection")?.value;
  if (typeof projection !== "string") return undefined;
  const parameters = projectionParameters(projection);
  if (
    parameters.proj !== "aeqd" ||
    parameters.units !== "m" ||
    ![parameters.datum, parameters.ellps].includes("WGS84")
  ) {
    return undefined;
  }
  const latitude = Number(parameters.lat_0);
  const longitude = Number(parameters.lon_0);
  const falseEasting = Number(parameters.x_0 ?? 0);
  const falseNorthing = Number(parameters.y_0 ?? 0);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(falseEasting) ||
    !Number.isFinite(falseNorthing)
  ) {
    return undefined;
  }
  return inverseAzimuthalEquidistant(
    x - falseEasting,
    y - falseNorthing,
    latitude,
    longitude,
  );
}

export function probeAtPosition(
  metadata: Metadata,
  variable: Variable,
  probe: Probe,
): Probe {
  if (probe.latitude !== undefined && probe.longitude !== undefined) return probe;
  return { ...probe, ...geographicPosition(metadata, variable, probe.x, probe.y) };
}

export function formatPosition(
  metadata: Metadata,
  variable: Variable,
  x: number,
  y: number,
  known?: GeographicPosition,
): string {
  const position = known ?? geographicPosition(metadata, variable, x, y);
  return position
    ? `${formatLatitude(position.latitude)} · ${formatLongitude(position.longitude)}`
    : `${formatNumber(x)} · ${formatNumber(y)}`;
}

export function formatProbePosition(
  metadata: Metadata,
  variable: Variable,
  probe: Probe,
): string {
  const known = probe.latitude === undefined || probe.longitude === undefined
    ? undefined
    : { latitude: probe.latitude, longitude: probe.longitude };
  return formatPosition(metadata, variable, probe.x, probe.y, known);
}

function isLongitude(variable: Variable): boolean {
  return attributeText(variable, "standard_name") === "longitude" ||
    (attributeText(variable, "units") ?? "").startsWith("degrees_east");
}

function isLatitude(variable: Variable): boolean {
  return attributeText(variable, "standard_name") === "latitude" ||
    (attributeText(variable, "units") ?? "").startsWith("degrees_north");
}

function projectionParameters(projection: string): Record<string, string> {
  return Object.fromEntries(
    projection.split(/\s+/).filter((part) => part.startsWith("+")).map((part) => {
      const [name, value = ""] = part.slice(1).split("=", 2);
      return [name, value];
    }),
  );
}

function inverseAzimuthalEquidistant(
  x: number,
  y: number,
  centerLatitude: number,
  centerLongitude: number,
): GeographicPosition {
  const distance = Math.hypot(x, y);
  if (distance === 0) return { latitude: centerLatitude, longitude: centerLongitude };
  return directWgs84(centerLatitude, centerLongitude, Math.atan2(x, y), distance);
}

// UGRID files commonly store a WGS84 azimuthal-equidistant origin. Inverting
// that projection is the WGS84 direct-geodesic problem: start at the origin,
// follow the projected bearing, and travel the projected distance.
function directWgs84(
  startLatitude: number,
  startLongitude: number,
  bearing: number,
  distance: number,
): GeographicPosition {
  const majorRadius = 6_378_137;
  const flattening = 1 / 298.257_223_563;
  const minorRadius = (1 - flattening) * majorRadius;
  const startLatitudeRadians = toRadians(startLatitude);
  const reducedLatitudeTangent = (1 - flattening) * Math.tan(startLatitudeRadians);
  const reducedLatitudeCosine = 1 / Math.sqrt(1 + reducedLatitudeTangent ** 2);
  const reducedLatitudeSine = reducedLatitudeTangent * reducedLatitudeCosine;
  const bearingSine = Math.sin(bearing);
  const bearingCosine = Math.cos(bearing);
  const sigmaOrigin = Math.atan2(reducedLatitudeTangent, bearingCosine);
  const alphaSine = reducedLatitudeCosine * bearingSine;
  const alphaCosineSquared = 1 - alphaSine ** 2;
  const ellipsoid = alphaCosineSquared *
    (majorRadius ** 2 - minorRadius ** 2) / minorRadius ** 2;
  const coefficientA = 1 + ellipsoid / 16_384 *
    (4_096 + ellipsoid * (-768 + ellipsoid * (320 - 175 * ellipsoid)));
  const coefficientB = ellipsoid / 1_024 *
    (256 + ellipsoid * (-128 + ellipsoid * (74 - 47 * ellipsoid)));

  let sigma = distance / (minorRadius * coefficientA);
  let previousSigma = Number.POSITIVE_INFINITY;
  let middleCosine = 0;
  let sigmaSine = 0;
  let sigmaCosine = 0;
  for (let iteration = 0; iteration < 20 && Math.abs(sigma - previousSigma) > 1e-12; iteration += 1) {
    middleCosine = Math.cos(2 * sigmaOrigin + sigma);
    sigmaSine = Math.sin(sigma);
    sigmaCosine = Math.cos(sigma);
    const correction = coefficientB * sigmaSine * (
      middleCosine + coefficientB / 4 * (
        sigmaCosine * (-1 + 2 * middleCosine ** 2) -
        coefficientB / 6 * middleCosine * (-3 + 4 * sigmaSine ** 2) * (-3 + 4 * middleCosine ** 2)
      )
    );
    previousSigma = sigma;
    sigma = distance / (minorRadius * coefficientA) + correction;
  }

  const latitudeTerm = reducedLatitudeSine * sigmaSine -
    reducedLatitudeCosine * sigmaCosine * bearingCosine;
  const latitude = Math.atan2(
    reducedLatitudeSine * sigmaCosine + reducedLatitudeCosine * sigmaSine * bearingCosine,
    (1 - flattening) * Math.sqrt(alphaSine ** 2 + latitudeTerm ** 2),
  );
  const longitudeDifference = Math.atan2(
    sigmaSine * bearingSine,
    reducedLatitudeCosine * sigmaCosine - reducedLatitudeSine * sigmaSine * bearingCosine,
  );
  const coefficientC = flattening / 16 * alphaCosineSquared *
    (4 + flattening * (4 - 3 * alphaCosineSquared));
  const longitudeCorrection = longitudeDifference - (1 - coefficientC) * flattening * alphaSine * (
    sigma + coefficientC * sigmaSine * (
      middleCosine + coefficientC * sigmaCosine * (-1 + 2 * middleCosine ** 2)
    )
  );
  const longitude = startLongitude + toDegrees(longitudeCorrection);
  return {
    latitude: toDegrees(latitude),
    longitude: ((longitude + 540) % 360) - 180,
  };
}

function formatLatitude(latitude: number): string {
  return `${coordinateMagnitude(latitude)}°${latitude < 0 ? "S" : "N"}`;
}

function formatLongitude(longitude: number): string {
  return `${coordinateMagnitude(longitude)}°${longitude < 0 ? "W" : "E"}`;
}

function coordinateMagnitude(value: number): string {
  return Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function toDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}
