export function decodePolyline(encoded: string) {
  const poly = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    const latlng = [lat * 1e-5, lng * 1e-5];
    poly.push(latlng);
  }
  return poly;
}

async function getRouteDistance(start: number[], end: number[]) {
  const [startLat, startLng] = start;
  const [endLat, endLng] = end;

  const response = await fetch(
    `https://graphhopper.com/api/1/route?point=${startLat},${startLng}&point=${endLat},${endLng}&vehicle=car&key=${process.env.GRAPH_HOPPER_API_KEY}`
  );

  const data = await response.json();

  if (data.paths && data.paths.length > 0) {
    const distance = data.paths[0].distance; // distance in meters
    return distance / 1000; // convert to kilometers
  }

  throw new Error("Unable to calculate route distance");
}

export async function calculateDetourDistance(
  existingRoute: number[][],
  startLocation: number[],
  endLocation: number[]
) {
  const [driverStartLat, driverStartLng] = existingRoute[0]; // Starting point of the existing route
  const [driverEndLat, driverEndLng] = existingRoute[existingRoute.length - 1]; // Ending point of the existing route

  // Calculate the original route distance
  const originalRouteDistance = await getRouteDistance(
    [driverStartLat, driverStartLng],
    [driverEndLat, driverEndLng]
  );

  // Calculate the detour route distances
  const detourToPickupDistance = await getRouteDistance(
    [driverStartLat, driverStartLng],
    startLocation
  );
  const pickupToDropoffDistance = await getRouteDistance(
    startLocation,
    endLocation
  );
  const dropoffToEndDistance = await getRouteDistance(endLocation, [
    driverEndLat,
    driverEndLng,
  ]);

  // Calculate the total detour distance
  const totalDetourDistance =
    detourToPickupDistance + pickupToDropoffDistance + dropoffToEndDistance;

  // Calculate the additional distance caused by the detour
  const detourDistance = totalDetourDistance - originalRouteDistance;

  return detourDistance;
}

function toRadians(degrees: number) {
  return degrees * (Math.PI / 180);
}

function calculateBearing(start: number[], end: number[]) {
  const [startLat, startLng] = start.map(toRadians);
  const [endLat, endLng] = end.map(toRadians);

  const dLng = endLng - startLng;
  const y = Math.sin(dLng) * Math.cos(endLat);
  const x =
    Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(dLng);
  const bearing = Math.atan2(y, x);

  return (bearing * 180) / Math.PI; // Convert radians to degrees
}

function calculateAngleDifference(angle1: number, angle2: number) {
  let diff = Math.abs(angle1 - angle2);
  if (diff > 180) {
    diff = 360 - diff;
  }
  return diff;
}

export async function checkDirection(
  existingRoute: number[][],
  startLocation: number[],
  endLocation: number[]
) {
  const [existingStart, existingEnd] = [
    existingRoute[0],
    existingRoute[existingRoute.length - 1],
  ];

  // Calculate bearings for the existing route and new passenger's route
  const existingBearing = calculateBearing(existingStart, existingEnd);
  const newPassengerBearing = calculateBearing(startLocation, endLocation);

  // Calculate the difference in bearings
  const angleDifference = calculateAngleDifference(
    existingBearing,
    newPassengerBearing
  );

  // If the angle difference is within a certain threshold, consider it the same direction
  const threshold = 45; // Example threshold in degrees, can be adjusted
  return angleDifference <= threshold;
}
