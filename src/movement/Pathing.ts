import {log} from '../console/log';
import {profile} from '../profiler/decorator';
import {Cartographer, ROOMTYPE_ALLEY, ROOMTYPE_SOURCEKEEPER} from '../utilities/Cartographer';
import {Zerg} from '../zerg/Zerg';
import {MoveOptions} from './Movement';
import {hasPos} from '../declarations/typeGuards';
import {normalizePos} from './helpers';
import {derefCoords} from '../utilities/utils';

/* Module for pathing-related operations. */

const DEFAULT_MAXOPS = 20000;		// Default timeout for pathfinding

export interface TerrainCosts {
	plainCost: number,
	swampCost: number
}

@profile
export class Pathing {

	// Room avoidance methods ==========================================================================================

	/* Check if the room should be avoiding when calculating routes */
	static shouldAvoid(roomName: string) {
		return Memory.rooms[roomName] && Memory.rooms[roomName].avoid;
	}

	/* Update memory on whether a room should be avoided based on controller owner */
	static updateRoomStatus(room: Room) {
		if (!room) {
			return;
		}
		if (room.controller) {
			if (room.controller.owner && !room.controller.my && room.towers.length > 0) {
				room.memory.avoid = true;
			} else {
				delete room.memory.avoid;
				if (room.memory.expansionData == false) delete room.memory.expansionData;
			}
		}
	}

	// Pathfinding and room callback methods ===========================================================================

	/* Find a path from origin to destination */
	static findPath(origin: RoomPosition, destination: RoomPosition, options: MoveOptions = {}): PathFinderPath {
		_.defaults(options, {
			ignoreCreeps: true,
			maxOps      : DEFAULT_MAXOPS,
			range       : 1,
			terrainCosts: {plainCost: 1, swampCost: 5},
		});

		if (options.movingTarget) {
			options.range = 0;
		}

		// check to see whether findRoute should be used
		let roomDistance = Game.map.getRoomLinearDistance(origin.roomName, destination.roomName);
		let allowedRooms = options.route;
		if (!allowedRooms && (options.useFindRoute || (options.useFindRoute == undefined && roomDistance > 2))) {
			allowedRooms = this.findRoute(origin.roomName, destination.roomName, options);
		}

		if (options.direct) {
			options.terrainCosts = {plainCost: 1, swampCost: 1};
		}

		let callback = (roomName: string) => this.roomCallback(roomName, origin, destination, allowedRooms, options);
		let ret = PathFinder.search(origin, {pos: destination, range: options.range!}, {
			maxOps      : options.maxOps,
			maxRooms    : options.maxRooms,
			plainCost   : options.terrainCosts!.plainCost,
			swampCost   : options.terrainCosts!.swampCost,
			roomCallback: callback,
		});

		if (ret.incomplete && options.ensurePath) {
			if (options.useFindRoute == undefined) {
				// handle case where pathfinder failed at a short distance due to not using findRoute
				// can happen for situations where the creep would have to take an uncommonly indirect path
				// options.allowedRooms and options.routeCallback can also be used to handle this situation
				if (roomDistance <= 2) {
					log.warning(`Movement: path failed without findroute. Origin: ${origin.print}, ` +
								`destination: ${destination.print}. Trying again with options.useFindRoute = true...`);
					options.useFindRoute = true;
					ret = this.findPath(origin, destination, options);
					log.warning(`Movement: second attempt was ${ret.incomplete ? 'not ' : ''}successful`);
					return ret;
				}
			} else {

			}
		}
		return ret;
	}

	/* Returns the shortest path from start to end position, regardless of (passable) terrain */
	static findShortestPath(startPos: RoomPosition, endPos: RoomPosition,
							options: MoveOptions = {}): PathFinderPath {
		_.defaults(options, {
			ignoreCreeps: true,
			range       : 1,
			direct      : true,
		});
		let ret = this.findPath(startPos, endPos, options);
		if (ret.incomplete) log.alert(`Pathing: incomplete path from ${startPos.print} to ${endPos.print}!`);
		return ret;
	}

	/* Returns the shortest path from start to end position, regardless of (passable) terrain */
	static findPathToRoom(startPos: RoomPosition, roomName: string, options: MoveOptions = {}): PathFinderPath {
		options.range = 23;
		let ret = this.findPath(startPos, new RoomPosition(25, 25, roomName), options);
		if (ret.incomplete) log.alert(`Pathing: incomplete path from ${startPos.print} to ${roomName}!`);
		return ret;
	}

	static roomCallback(roomName: string, origin: RoomPosition, destination: RoomPosition,
						allowedRooms: { [roomName: string]: boolean } | undefined,
						options: MoveOptions): CostMatrix | boolean {
		if (allowedRooms && !allowedRooms[roomName]) {
			return false;
		}
		if (!options.allowHostile && this.shouldAvoid(roomName)
			&& roomName != origin.roomName && roomName != destination.roomName) {
			return false;
		}

		const room = Game.rooms[roomName];
		if (room) {
			let matrix = this.getCostMatrix(room, options, false);
			// Modify cost matrix if needed
			if (options.modifyRoomCallback) {
				return options.modifyRoomCallback(room, matrix.clone());
			} else {
				return matrix;
			}
		} else { // have no vision
			return true;
		}
	}

	private static kitingRoomCallback(roomName: string): CostMatrix | boolean {
		const room = Game.rooms[roomName];
		if (room) {
			return this.getKitingMatrix(room);
		} else { // have no vision
			return true;
		}
	}

	/* Get a kiting path within a room */
	static findKitingPath(creepPos: RoomPosition, fleeFrom: (RoomPosition | HasPos)[],
						  options: MoveOptions = {}): PathFinderPath {
		_.defaults(options, {
			range       : 5,
			terrainCosts: {plainCost: 1, swampCost: 5},
		});
		let fleeFromPos = _.map(fleeFrom, flee => normalizePos(flee));
		let avoidGoals = _.map(fleeFromPos, pos => {
			return {pos: pos, range: options.range!};
		});
		return PathFinder.search(creepPos, avoidGoals,
								 {
									 plainCost   : options.terrainCosts!.plainCost,
									 swampCost   : options.terrainCosts!.swampCost,
									 flee        : true,
									 roomCallback: Pathing.kitingRoomCallback,
									 maxRooms    : 1
								 });
	}

	/* Get a flee path possibly leaving the room; generally called further in advance of kitingPath */
	static findFleePath(creepPos: RoomPosition, fleeFrom: (RoomPosition | HasPos)[],
						options: MoveOptions = {}): PathFinderPath {
		_.defaults(options, {
			terrainCosts: {plainCost: 1, swampCost: 5},
		});
		if (options.range == undefined) options.range = options.terrainCosts!.plainCost > 1 ? 20 : 10;
		let fleeFromPos = _.map(fleeFrom, flee => normalizePos(flee));
		let avoidGoals = _.map(fleeFromPos, pos => {
			return {pos: pos, range: options.range!};
		});
		const callback = (roomName: string) => {
			if (!options.allowHostile && this.shouldAvoid(roomName) && roomName != creepPos.roomName) {
				return false;
			}
			const room = Game.rooms[roomName];
			if (room) {
				let matrix = this.getCostMatrix(room, options, false);
				// Modify cost matrix if needed
				if (options.modifyRoomCallback) {
					return options.modifyRoomCallback(room, matrix.clone());
				} else {
					return matrix;
				}
			} else { // have no vision
				return true;
			}
		};
		return PathFinder.search(creepPos, avoidGoals,
								 {
									 plainCost   : options.terrainCosts!.plainCost,
									 swampCost   : options.terrainCosts!.swampCost,
									 flee        : true,
									 roomCallback: callback,
								 });
	}

	// Cost matrix computations ========================================================================================

	static setCostsInRange(matrix: CostMatrix, pos: RoomPosition | HasPos, range: number, cost = 30, add = false) {
		pos = normalizePos(pos);
		for (let dx = -range; dx <= range; dx++) {
			let x = pos.x + dx;
			if (x < 0 || x > 49) continue;
			for (let dy = -range; dy <= range; dy++) {
				let y = pos.y + dy;
				if (y < 0 || y > 49) continue;
				let terrain = Game.map.getTerrainAt(x, y, pos.roomName);
				if (terrain === 'wall') {
					continue;
				}
				let currentCost = matrix.get(x, y);
				if (currentCost === 0) {
					if (terrain === 'plain') {
						currentCost += 2;
					} else {
						currentCost += 10;
					}
				}
				if (currentCost >= 0xff || currentCost > cost) continue;
				matrix.set(x, y, add ? Math.min(cost + currentCost, 200) : cost);
			}
		}
	}


	static blockExits(matrix: CostMatrix, rangeToEdge = 0, roomName?: string): void {
		for (let x = rangeToEdge; x < 50 - rangeToEdge; x += 49 - rangeToEdge * 2) {
			for (let y = rangeToEdge; y < 50 - rangeToEdge; y++) {
				matrix.set(x, y, 0xff);
			}
		}
		for (let x = rangeToEdge; x < 50 - rangeToEdge; x++) {
			for (let y = rangeToEdge; y < 50 - rangeToEdge; y += 49 - rangeToEdge * 2) {
				matrix.set(x, y, 0xff);
			}
		}
	}


	/* Get a cloned copy of the cost matrix for a room with specified options */
	static getCostMatrix(room: Room, options = {} as MoveOptions, clone = true): CostMatrix {
		let matrix: CostMatrix;
		if (options.ignoreCreeps == false) {
			matrix = this.getCreepMatrix(room);
		} else if (options.avoidSK) {
			matrix = this.getSkMatrix(room);
		} else if (options.ignoreStructures) {
			matrix = new PathFinder.CostMatrix();
		} else if (options.direct) {
			matrix = this.getDirectMatrix(room);
		} else {
			matrix = this.getDefaultMatrix(room);
		}
		// Register other obstacles
		if (options.obstacles && options.obstacles.length > 0) {
			matrix = matrix.clone();
			for (let obstacle of options.obstacles) {
				if (obstacle && obstacle.roomName == room.name) {
					matrix.set(obstacle.x, obstacle.y, 0xff);
				}
			}
		}
		if (clone) {
			matrix = matrix.clone();
		}
		return matrix;
	}

	/* Get a cloned copy of the cost matrix for a room with specified options */
	private static getCostMatrixForInvisibleRoom(roomName: string, options = {} as MoveOptions,
												 clone                     = true): CostMatrix | boolean {
		let matrix: CostMatrix;
		if (options.avoidSK) {
			matrix = this.getInvisibleSkMatrix(roomName);
		} else {
			matrix = new PathFinder.CostMatrix();
		}
		// Register other obstacles
		if (options.obstacles && options.obstacles.length > 0) {
			matrix = matrix.clone();
			for (let obstacle of options.obstacles) {
				if (obstacle && obstacle.roomName == roomName) {
					matrix.set(obstacle.x, obstacle.y, 0xff);
				}
			}
		}
		if (clone) {
			matrix = matrix.clone();
		}
		return matrix;
	}


	/* Default matrix for a room, setting impassable structures and constructionSites to impassible */
	static getDefaultMatrix(room: Room): CostMatrix {
		if (room._defaultMatrix) {
			return room._defaultMatrix;
		}
		let matrix = new PathFinder.CostMatrix();
		// Set passability of structure positions
		let impassibleStructures: Structure[] = [];
		_.forEach(room.find(FIND_STRUCTURES), (s: Structure) => {
			if (s.structureType == STRUCTURE_ROAD) {
				matrix.set(s.pos.x, s.pos.y, 1);
			} else if (!s.isWalkable) {
				impassibleStructures.push(s);
			}
		});
		_.forEach(impassibleStructures, s => matrix.set(s.pos.x, s.pos.y, 0xff));
		// Set passability of construction sites
		_.forEach(room.find(FIND_CONSTRUCTION_SITES), (site: ConstructionSite) => {
			if (site.my && !site.isWalkable) {
				matrix.set(site.pos.x, site.pos.y, 0xff);
			}
		});
		room._defaultMatrix = matrix;
		return room._defaultMatrix;
	}


	/* Default matrix for a room, setting impassable structures and constructionSites to impassible, ignoring roads */
	static getDirectMatrix(room: Room): CostMatrix {
		if (room._directMatrix) {
			return room._directMatrix;
		}
		let matrix = new PathFinder.CostMatrix();
		// Set passability of structure positions
		let impassibleStructures: Structure[] = [];
		_.forEach(room.find(FIND_STRUCTURES), (s: Structure) => {
			if (!s.isWalkable) {
				impassibleStructures.push(s);
			}
		});
		_.forEach(impassibleStructures, s => matrix.set(s.pos.x, s.pos.y, 0xff));
		// Set passability of construction sites
		_.forEach(room.find(FIND_CONSTRUCTION_SITES), (site: ConstructionSite) => {
			if (site.my && !site.isWalkable) {
				matrix.set(site.pos.x, site.pos.y, 0xff);
			}
		});
		room._directMatrix = matrix;
		return room._directMatrix;
	}


	/* Avoids creeps in a room */
	static getCreepMatrix(room: Room, fromMatrix?: CostMatrix): CostMatrix {
		if (room._creepMatrix) {
			return room._creepMatrix;
		}
		let matrix = this.getDefaultMatrix(room).clone();
		_.forEach(room.find(FIND_CREEPS), c => matrix.set(c.pos.x, c.pos.y, 0xff));
		room._creepMatrix = matrix;
		return room._creepMatrix;
	}


	/* Kites around hostile creeps in a room */
	static getKitingMatrix(room: Room): CostMatrix {
		if (room._kitingMatrix) {
			return room._kitingMatrix;
		}
		let matrix = this.getCreepMatrix(room).clone();
		let avoidCreeps = _.filter(room.hostiles,
								   c => c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0); // || c.getActiveBodyparts(HEAL) > 0);
		_.forEach(avoidCreeps, avoidCreep => {
			let cost: number;
			for (let dx = -3; dx <= 3; dx++) {
				for (let dy = -3; dy <= 3; dy++) {
					cost = matrix.get(avoidCreep.pos.x + dx, avoidCreep.pos.y + dy);
					cost += 40 - (10 * Math.max(Math.abs(dx), Math.abs(dy)));
					matrix.set(avoidCreep.pos.x + dx, avoidCreep.pos.y + dy, cost);
				}
			}
		});
		room._kitingMatrix = matrix;
		return room._kitingMatrix;
	}


	// /* Avoids creeps that shouldn't be pushed in a room */ // TODO: plug in
	// private static getPrioritizedCreepMatrix(room: Room, priority: number): CostMatrix {
	// 	if (!room._priorityMatrices) {
	// 		room._priorityMatrices = {};
	// 	}
	// 	if (room._priorityMatrices[priority]) {
	// 		return room._priorityMatrices[priority];
	// 	}
	// 	const matrix = this.getDefaultMatrix(room).clone();
	// 	let otherPriority = MovePriorities.default;
	// 	for (let creep of room.creeps) {
	// 		if (!Movement.shouldPush(creep, priority)) {
	// 			matrix.set(creep.pos.x, creep.pos.y, 0xff);
	// 		}
	// 	}
	// 	room._priorityMatrices[priority] = matrix;
	// 	return room._priorityMatrices[priority];
	// }


	/* Avoids source keepers in a room */
	private static getSkMatrix(room: Room): CostMatrix {
		if (Cartographer.roomType(room.name) != ROOMTYPE_SOURCEKEEPER) {
			return this.getDefaultMatrix(room);
		}
		if (room._skMatrix) {
			return room._skMatrix;
		}
		let matrix = this.getDefaultMatrix(room).clone();
		const avoidRange = 5;
		_.forEach(room.keeperLairs, lair => {
			for (let dx = -avoidRange; dx <= avoidRange; dx++) {
				for (let dy = -avoidRange; dy <= avoidRange; dy++) {
					matrix.set(lair.pos.x + dx, lair.pos.y + dy, 0xff);
				}
			}
		});
		room._skMatrix = matrix;
		return room._skMatrix;
	}

	/* Avoids source keepers in a room */
	private static getInvisibleSkMatrix(roomName: string): CostMatrix {
		let matrix = new PathFinder.CostMatrix();
		if (Cartographer.roomType(roomName) == ROOMTYPE_SOURCEKEEPER) {
			if (Memory.rooms[roomName] && Memory.rooms[roomName].SKlairs != undefined) {

				const avoidRange = 5;
				const lairs: RoomPosition[] = _.map(Memory.rooms[roomName].SKlairs!,
													saved => derefCoords(saved.c, roomName));
				_.forEach(lairs, lair => {
					for (let dx = -avoidRange; dx <= avoidRange; dx++) {
						for (let dy = -avoidRange; dy <= avoidRange; dy++) {
							matrix.set(lair.x + dx, lair.y + dy, 0xff);
						}
					}
				});
			}
		}
		return matrix;
	}

	/* Find a viable sequence of rooms to narrow down Pathfinder algorithm */
	static findRoute(origin: string, destination: string,
					 options: MoveOptions = {}): { [roomName: string]: boolean } | undefined {
		let linearDistance = Game.map.getRoomLinearDistance(origin, destination);
		let restrictDistance = options.restrictDistance || linearDistance + 10;
		let allowedRooms = {[origin]: true, [destination]: true};

		// Determine whether to use highway bias
		let highwayBias = 1;
		if (options.preferHighway) {
			highwayBias = 2.5;
		} else if (options.preferHighway != false) {
			// if (linearDistance > 8) {
			// 	highwayBias = 2.5;
			// } else {
			// 	let oCoords = Cartographer.getRoomCoordinates(origin);
			// 	let dCoords = Cartographer.getRoomCoordinates(destination);
			// 	if (_.any([oCoords.x, oCoords.y, dCoords.x, dCoords.y], z => z % 10 <= 1 || z % 10 >= 9)) {
			// 		highwayBias = 2.5;
			// 	}
			// }

		}

		let ret = Game.map.findRoute(origin, destination, {
			routeCallback: (roomName: string) => {
				let rangeToRoom = Game.map.getRoomLinearDistance(origin, roomName);
				if (rangeToRoom > restrictDistance) { // room is too far out of the way
					return Number.POSITIVE_INFINITY;
				}
				if (!options.allowHostile && this.shouldAvoid(roomName) &&
					roomName !== destination && roomName !== origin) { // room is marked as "avoid" in room memory
					return Number.POSITIVE_INFINITY;
				}
				if (options.preferHighway && Cartographer.roomType(roomName) == ROOMTYPE_ALLEY) {
					return 1;
				}
				return highwayBias;
			},
		});

		if (!_.isArray(ret)) {
			log.warning(`Movement: couldn't findRoute from ${origin} to ${destination}!`);
		} else {
			for (let value of ret) {
				allowedRooms[value.room] = true;
			}
			return allowedRooms;
		}
	}

	/* Serialize a path as a string of move directions */
	static serializePath(startPos: RoomPosition, path: RoomPosition[], color = 'orange'): string {
		let serializedPath = '';
		let lastPosition = startPos;
		for (let position of path) {
			if (position.roomName == lastPosition.roomName) {
				new RoomVisual(position.roomName)
					.line(position, lastPosition, {color: color, lineStyle: 'dashed'});
				serializedPath += lastPosition.getDirectionTo(position);
			}
			lastPosition = position;
		}
		return serializedPath;
	}

	static nextDirectionInPath(creep: Zerg): number | undefined {
		let moveData = creep.memory._go as MoveData;
		if (!moveData || !moveData.path || moveData.path.length == 0) {
			return;
		}
		return Number.parseInt(moveData.path[0]);
	}

	static nextPositionInPath(creep: Zerg): RoomPosition | undefined {
		let nextDir = this.nextDirectionInPath(creep);
		if (!nextDir) {
			return;
		}
		return this.positionAtDirection(creep.pos, nextDir);
	}

	static oppositeDirection(direction: DirectionConstant): DirectionConstant {
		switch (direction) {
			case TOP:
				return BOTTOM;
			case TOP_LEFT:
				return BOTTOM_RIGHT;
			case LEFT:
				return RIGHT;
			case BOTTOM_LEFT:
				return TOP_RIGHT;
			case BOTTOM:
				return TOP;
			case BOTTOM_RIGHT:
				return TOP_LEFT;
			case RIGHT:
				return LEFT;
			case TOP_RIGHT:
				return BOTTOM_LEFT;
		}
	}

	/* Returns a position at a direction from origin */
	static positionAtDirection(origin: RoomPosition, direction: number): RoomPosition | undefined {
		const offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
		const offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
		let x = origin.x + offsetX[direction];
		let y = origin.y + offsetY[direction];
		if (x > 49 || x < 0 || y > 49 || y < 0) {
			return;
		}
		return new RoomPosition(x, y, origin.roomName);
	}

	static savePath(path: RoomPosition[]): void {
		let savedPath: CachedPath = {
			path  : path,
			length: path.length,
			tick  : Game.time
		};
		let originName = _.first(path).name;
		let destinationName = _.last(path).name;
		if (!Memory.pathing.paths[originName]) {
			Memory.pathing.paths[originName] = {};
		}
		Memory.pathing.paths[originName][destinationName] = savedPath;
	}

	// Distance and path weight calculations ===========================================================================

	/* Calculate and/or cache the length of the shortest path between two points.
	 * Cache is probabilistically cleared in Mem */
	static distance(arg1: RoomPosition, arg2: RoomPosition): number {
		let [name1, name2] = [arg1.name, arg2.name].sort(); // alphabetize since path is the same in either direction
		if (!Memory.pathing.distances[name1]) {
			Memory.pathing.distances[name1] = {};
		}
		if (!Memory.pathing.distances[name1][name2]) {
			let ret = this.findShortestPath(arg1, arg2);
			if (!ret.incomplete) {
				Memory.pathing.distances[name1][name2] = ret.path.length;
			}
		}
		return Memory.pathing.distances[name1][name2];
	}

	static calculatePathWeight(startPos: RoomPosition, endPos: RoomPosition, options: MoveOptions = {}): number {
		_.defaults(options, {
			range: 1,
		});
		let ret = this.findPath(startPos, endPos, options);
		let weight = 0;
		for (let pos of ret.path) {
			if (!pos.room) { // If you don't have vision, assume there are roads
				weight += 1;
			} else {
				if (pos.lookForStructure(STRUCTURE_ROAD)) {
					weight += 1;
				} else {
					let terrain = pos.lookFor(LOOK_TERRAIN)[0];
					if (terrain == 'plain') {
						weight += 2;
					} else if (terrain == 'swamp') {
						weight += 10;
					}
				}
			}
		}
		return weight;
	}

	/* Calculates and/or caches the weighted distance for the most efficient path. Weight is sum of tile weights:
	 * Road = 1, Plain = 2, Swamp = 10. Cached weights are cleared in Mem occasionally. */
	static weightedDistance(arg1: RoomPosition, arg2: RoomPosition): number {
		let pos1, pos2: RoomPosition;
		if (arg1.name < arg2.name) { // alphabetize since path lengths are the same either direction
			pos1 = arg1;
			pos2 = arg2;
		} else {
			pos1 = arg2;
			pos2 = arg1;
		}
		if (!Memory.pathing.weightedDistances[pos1.name]) {
			Memory.pathing.weightedDistances[pos1.name] = {};
		}
		if (!Memory.pathing.weightedDistances[pos1.name][pos2.name]) {
			Memory.pathing.weightedDistances[pos1.name][pos2.name] = this.calculatePathWeight(pos1, pos2);
		}
		return Memory.pathing.weightedDistances[pos1.name][pos2.name];
	}

	/* Whether another object in the same room can be reached from the current position */
	static isReachable(startPos: RoomPosition, endPos: RoomPosition, obstacles: (RoomPosition | HasPos)[],
					   options: MoveOptions = {}): boolean {
		_.defaults(options, {
			ignoreCreeps: true,
			range       : 1,
			maxOps      : 1000,
			ensurePath  : false,
		});
		if (startPos.roomName != endPos.roomName) {
			log.error(`isReachable() should only be used within a single room!`);
			return false;
		}
		const matrix = new PathFinder.CostMatrix();
		_.forEach(obstacles, obstacle => {
			if (hasPos(obstacle)) {
				matrix.set(obstacle.pos.x, obstacle.pos.y, 0xfe);
			} else {
				matrix.set(obstacle.x, obstacle.y, 0xfe);
			}
		});
		let callback = (roomName: string) => roomName == endPos.roomName ? matrix : false;
		let ret = PathFinder.search(startPos, {pos: endPos, range: options.range!}, {
			maxOps      : options.maxOps,
			plainCost   : 1,
			swampCost   : 5,
			maxRooms    : 1,
			roomCallback: callback,
		});
		if (ret.incomplete) {
			return false;
		} else {
			for (let pos of ret.path) {
				if (matrix.get(pos.x, pos.y) > 100) {
					return false;
				}
			}
		}
		return true;
	}

	/* Find the first walkable position in the room, spiraling outward from the center */
	static findPathablePosition(roomName: string): RoomPosition {
		let x = 25;
		let y = 25;
		for (let radius = 0; radius < 23; radius++) {
			for (let dx = -radius; dx <= radius; dx++) {
				for (let dy = -radius; dy <= radius; dy++) {
					if (Math.abs(dy) !== radius && Math.abs(dx) !== radius) {
						continue;
					}
					x = 25 + dx;
					y = 25 + dy;
					if (Game.map.getTerrainAt(x, y, roomName) !== 'wall') {
						return new RoomPosition(x, y, roomName);
					}
				}
			}
		}
		// Should never reach here!
		return new RoomPosition(-10, -10, 'cannotFindPathablePosition');
	}

}

