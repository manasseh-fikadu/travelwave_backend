import { Request, Response } from "express";
import RideRequest from "./model";
import RideRequestInterface from "./interface";
import VehicleSchema from "../vehicles/model";
import RideSchema from "../ride/model";
import dataAccessLayer from "../../common/dal";
import db from "../../services/db";
import {
  findNearbyDrivers,
  calculateETA,
} from "../../services/driverLocationService";
import {
  sendRideRequestNotification,
  sendRideRequestAcceptedNotification,
} from "../../services/notificationService";
import { oneRideFarePriceCalculator } from "../../services/priceCalculationService";

const rideRequestDAL = dataAccessLayer(RideRequest);
const vehicleDAL = dataAccessLayer(VehicleSchema);
const rideDAL = dataAccessLayer(RideSchema);

async function fetchRoute(origin: number[], destination: number[]) {
  const response = await fetch(
    `https://graphhopper.com/api/1/route?point=${origin[0]},${origin[1]}&point=${destination[0]},${destination[1]}&key=${process.env.GRAPH_HOPPER_API_KEY}`
  );
  const data = await response.json();
  if (data.paths && data.paths.length > 0) {
    const encodedPoints = data.paths[0].points;
    return encodedPoints;
  }
  return null;
}

async function createRideRequestHelper(
  req: Request,
  res: Response,
  isScheduled: boolean,
  isPooled: boolean
) {
  try {
    const rideRequest: RideRequestInterface = req.body;
    const user = req.user;

    rideRequest.passenger = user._id;
    rideRequest.request_time = new Date();
    rideRequest.is_scheduled = isScheduled;
    rideRequest.is_pooled = isPooled;

    if (isScheduled) {
      rideRequest.scheduled_time = new Date(rideRequest.scheduled_time);
    }

    const origin = [rideRequest.start_latitude, rideRequest.start_longitude];
    const destination = [rideRequest.end_latitude, rideRequest.end_longitude];

    const shortestPath = await fetchRoute(origin, destination);
    if (!shortestPath) {
      throw new Error("No path found");
    }

    rideRequest.shortest_path = shortestPath;
    rideRequest.status = "pending";

    const createdRideRequest = await rideRequestDAL.createOne(rideRequest);

    const nearbyDrivers = await findNearbyDrivers(origin);
    for (const driver of nearbyDrivers) {
      await sendRideRequestNotification(
        driver,
        `New ride request from ${user.full_name}`
      );
    }

    res.status(201).json(createdRideRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

const processOneRideRequest = async (
  req: Request,
  res: Response,
  scheduled: boolean
) => {
  const session = await db.Connection.startSession();
  session.startTransaction();

  try {
    const id = req.params.id;
    const driverId = req.user._id;

    // Fetch rideRequest and car data in parallel
    const [rideRequest, car] = await Promise.all([
      rideRequestDAL.getOnePopulated({ _id: id }),
      vehicleDAL.getOnePopulated({ driver: driverId }),
    ]);

    if (!rideRequest || rideRequest.status !== "pending") {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ message: "Ride request not found or not in pending state" });
    }

    if (!car) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Driver not found" });
    }

    const carInfo = scheduled
      ? `A ${car.name}, ${car.make} ${car.model} color ${car.color} with license plate ${car.license_plate} will pick you up at ${rideRequest.scheduled_time}.`
      : `A ${car.name}, ${car.make} ${car.model} color ${car.color} with license plate ${car.license_plate} is on the way to pick you up.`;

    const ride = await rideDAL.getOnePopulated({ vehicle: car._id });

    if (!ride) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Ride not found" });
    }

    const driverLocation = [ride.latitude, ride.longitude];

    // Fetch passenger's location
    const passenger = await rideRequestDAL.getOne({ _id: id });
    if (!passenger) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Passenger not found" });
    }

    const passengerLocation = [
      passenger.start_latitude,
      passenger.start_longitude,
    ];

    // Calculate ETA and fare in parallel
    const [eta, fare] = await Promise.all([
      calculateETA(driverLocation, passengerLocation),
      oneRideFarePriceCalculator(rideRequest.shortest_path),
    ]);

    // Send notification to the user
    await sendRideRequestAcceptedNotification(
      rideRequest.passenger,
      `${carInfo} ETA: ${eta}`,
      fare
    );

    // Update the ride and ride request within the transaction
    ride.number_of_passengers += 1;
    ride.available_seats -= 1;
    ride.destination_latitude = passenger.end_latitude;
    ride.destination_longitude = passenger.end_longitude;
    ride.shortest_path = rideRequest.shortest_path;

    await rideDAL.updateOne(ride, ride._id);

    rideRequest.status = "accepted";
    rideRequest.driver = driverId;

    const updatedRideRequest = await rideRequestDAL.updateOne(rideRequest, id);

    await session.commitTransaction();
    session.endSession();

    res.status(200).json(updatedRideRequest);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

export const createOneRideRequest = (req: Request, res: Response) => {
  createRideRequestHelper(req, res, false, false);
};

export const createOneScheduledRideRequest = (req: Request, res: Response) => {
  createRideRequestHelper(req, res, true, false);
};

export const createPooledRideRequest = (req: Request, res: Response) => {
  createRideRequestHelper(req, res, false, true);
};

export const createPooledScheduledRideRequest = (
  req: Request,
  res: Response
) => {
  createRideRequestHelper(req, res, true, true);
};

export const getRideRequests = async (req: Request, res: Response) => {
  try {
    const rideRequests = await rideRequestDAL.getMany({});
    res.status(200).json(rideRequests);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const getRideRequest = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const rideRequest = await rideRequestDAL.getOne({ _id: id });
    res.status(200).json(rideRequest);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const getPooledRideRequests = async (req: Request, res: Response) => {
  try {
    const rideRequests = await rideRequestDAL.getAllPopulated({
      is_pooled: true,
    });
    res.status(200).json(rideRequests);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const getScheduledRideRequests = async (req: Request, res: Response) => {
  try {
    const rideRequests = await rideRequestDAL.getAllPopulated({
      is_scheduled: true,
    });
    res.status(200).json(rideRequests);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const getScheduledPooledRideRequests = async (
  req: Request,
  res: Response
) => {
  try {
    const rideRequests = await rideRequestDAL.getAllPopulated({
      is_scheduled: true,
      is_pooled: true,
    });
    res.status(200).json(rideRequests);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const cancelRideRequest = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const rideRequest = await rideRequestDAL.deleteOne(id, true);
    res.status(200).json(rideRequest);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const getAcceptedScheduledRideRequests = async (
  req: Request,
  res: Response
) => {
  try {
    const rideRequests = await rideRequestDAL.getAllPopulated({
      is_scheduled: true,
      status: "accepted",
    });
    res.status(200).json(rideRequests);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const acceptOneRideRequest = async (req: Request, res: Response) => {
  processOneRideRequest(req, res, false);
};

export const acceptOneScheduledRideRequest = async (
  req: Request,
  res: Response
) => {
  processOneRideRequest(req, res, true);
};

export default {
  createOneRideRequest,
  createOneScheduledRideRequest,
  createPooledRideRequest,
  createPooledScheduledRideRequest,
  getRideRequests,
  getRideRequest,
  getPooledRideRequests,
  getScheduledRideRequests,
  getScheduledPooledRideRequests,
  getAcceptedScheduledRideRequests,
  cancelRideRequest,
  acceptOneRideRequest,
  acceptOneScheduledRideRequest,
};
