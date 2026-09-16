const METERS_PER_LATITUDE = 111320

export function normalizeBearing(degrees) {
  return ((degrees % 360) + 360) % 360
}

export function distanceMeters(a, b) {
  const latitude = ((a.lat + b.lat) / 2) * Math.PI / 180
  const eastMeters = (b.lng - a.lng) * METERS_PER_LATITUDE * Math.cos(latitude)
  const northMeters = (b.lat - a.lat) * METERS_PER_LATITUDE
  return Math.hypot(eastMeters, northMeters)
}

export function offsetPointBD09(center, bearingDegrees, distance) {
  const bearing = normalizeBearing(bearingDegrees) * Math.PI / 180
  const latitudeRadians = center.lat * Math.PI / 180
  const northMeters = Math.cos(bearing) * distance
  const eastMeters = Math.sin(bearing) * distance
  return {
    lng: center.lng + eastMeters / (METERS_PER_LATITUDE * Math.cos(latitudeRadians)),
    lat: center.lat + northMeters / METERS_PER_LATITUDE,
  }
}

export function polarPoint(center, bearingDegrees, distance) {
  return { bearing: normalizeBearing(bearingDegrees), distance, point: offsetPointBD09(center, bearingDegrees, distance) }
}
