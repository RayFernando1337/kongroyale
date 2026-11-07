// Vehicle seats in the match simulation, as a Quint port of tools/formal/VehicleSeats.tla (spike, KONG-101).
// v.seats[k] (shared/sim/vehicle.ts) and each rider's own st = Ride, veh, seat (shared/sim/player.ts) store one fact
// twice; every way in and out of a seat must keep the two copies equal. One step is one function call that runs to
// completion inside Match.step. Same actions, same rules and same 3 kongs / 2 squads / 2 vehicles of 3 seats as the
// TLA+ model, so the two can be compared state for state.
module VehicleSeats {
  type PS = Ground | Ride | Dead
  type VS = Ok | Tipped | Righting | Wreck | Sunk | Gone

  pure val Players = Set("p1", "p2", "p3")
  pure val Vehicles = Set("v1", "v2")
  pure val Rivals = Set("p3")
  pure val NONE = "none"
  pure val Seats = 0.to(2)
  pure val EMPTY = Seats.mapBy(_ => NONE)

  pure def team(p: str): int = if (Rivals.contains(p)) 1 else 0

  var st: str -> PS
  var veh: str -> str
  var seat: str -> int
  var vst: str -> VS
  var seats: str -> (int -> str)
  var evt: str -> bool

  def riding(p: str): bool = if (p == NONE) false else st.get(p) == Ride

  // vehicle.ts freeSeat: the first empty seat, only on its wheels and only if no other squad is aboard
  def freeSeat(v: str, p: str): int = {
    val s = seats.get(v)
    if (vst.get(v) != Ok
        or Seats.exists(k => s.get(k) != NONE and team(s.get(k)) != team(p))
        or Seats.forall(k => s.get(k) != NONE)) -1
    else Seats.filter(k => s.get(k) == NONE).fold(3, (a, k) => if (k < a) k else a)
  }

  // vehicle.ts exitVehicle(p, v): the seat is freed only if it is still p's
  def exitSeats(p: str, v: str): str -> (int -> str) =
    if (seats.get(v).get(seat.get(p)) == p) seats.setBy(v, s => s.set(seat.get(p), NONE)) else seats

  // match.ts ejectAll: each kong still riding this vehicle in one of its seats gets out
  def thrown(p: str, v: str): bool = riding(p) and veh.get(p) == v and Seats.exists(k => seats.get(v).get(k) == p)

  action init = all {
    st' = Players.mapBy(_ => Ground),
    veh' = Players.mapBy(_ => NONE),
    seat' = Players.mapBy(_ => 0),
    vst' = Vehicles.mapBy(_ => Ok),
    seats' = Vehicles.mapBy(_ => EMPTY),
    evt' = Vehicles.mapBy(_ => false),
  }

  action ejectAll(v: str): bool = all {
    seats' = seats.set(v, EMPTY),
    st' = Players.mapBy(p => if (thrown(p, v)) Ground else st.get(p)),
    veh' = Players.mapBy(p => if (thrown(p, v)) NONE else veh.get(p)),
    seat' = Players.mapBy(p => if (thrown(p, v)) 0 else seat.get(p)),
  }

  // match.ts useVehicle: freeSeat then enterVehicle
  action enter(p: str, v: str): bool = all {
    st.get(p) == Ground,
    freeSeat(v, p) != -1,
    seats' = seats.setBy(v, s => s.set(freeSeat(v, p), p)),
    st' = st.set(p, Ride), veh' = veh.set(p, v), seat' = seat.set(p, freeSeat(v, p)),
    vst' = vst, evt' = evt,
  }

  // player.hot.ts stepRide: E pressed, or the vehicle left its wheels; a Gone vehicle is passed as null
  action getOut(p: str): bool = all {
    riding(p),
    seats' = if (vst.get(veh.get(p)) == Gone) seats else exitSeats(p, veh.get(p)),
    st' = st.set(p, Ground), veh' = veh.set(p, NONE), seat' = seat.set(p, 0),
    vst' = vst, evt' = evt,
  }

  // vehicle.ts switchSeat / takeSeat: only while the vehicle is on its wheels
  action switchSeat(p: str, k: int): bool = all {
    riding(p),
    vst.get(veh.get(p)) == Ok,
    k != seat.get(p),
    seats.get(veh.get(p)).get(k) == NONE,
    seats' = exitSeats(p, veh.get(p)).setBy(veh.get(p), s => s.set(k, p)),
    seat' = seat.set(p, k),
    st' = st, veh' = veh, vst' = vst, evt' = evt,
  }

  // match.ts kill: frees the seat if it is still this kong's, then veh = -1, st = Dead
  action die(p: str): bool = all {
    Set(Ground, Ride).contains(st.get(p)),
    seats' = if (riding(p)) exitSeats(p, veh.get(p)) else seats,
    st' = st.set(p, Dead),
    veh' = veh.set(p, NONE),
    seat' = seat, vst' = vst, evt' = evt,
  }

  action respawn(p: str): bool = all {
    st.get(p) == Dead,
    st' = st.set(p, Ground), veh' = veh.set(p, NONE), seat' = seat.set(p, 0),
    vst' = vst, seats' = seats, evt' = evt,
  }

  action tip(v: str): bool = all {
    vst.get(v) == Ok,
    vst' = vst.set(v, Tipped), evt' = evt.set(v, true),
    st' = st, veh' = veh, seat' = seat, seats' = seats,
  }

  action sink(v: str): bool = all {
    Set(Ok, Tipped, Righting).contains(vst.get(v)),
    vst' = vst.set(v, Sunk), evt' = evt.set(v, true),
    st' = st, veh' = veh, seat' = seat, seats' = seats,
  }

  // match.ts tukEvents: ejectAll on TIP or SUNK
  action events(v: str): bool = all { evt.get(v), vst.get(v) != Gone, ejectAll(v), evt' = evt.set(v, false), vst' = vst }

  // match.ts blowTuk: ejectAll, then a wreck
  action blow(v: str): bool = all { Set(Ok, Tipped, Righting).contains(vst.get(v)), ejectAll(v), vst' = vst.set(v, Wreck), evt' = evt }

  // match.ts stepVehicles: a wreck or a sunk vehicle is cleared away, or (warm-up) a fresh one spawns on its spot
  action clear(v: str): bool = {
    nondet after = Set(Gone, Ok).oneOf()
    all {
      Set(Wreck, Sunk).contains(vst.get(v)), not(evt.get(v)),
      vst' = vst.set(v, after),
      seats' = if (after == Ok) seats.set(v, EMPTY) else seats,
      st' = st, veh' = veh, seat' = seat, evt' = evt,
    }
  }

  action flip(v: str): bool = all { vst.get(v) == Tipped, vst' = vst.set(v, Righting), st' = st, veh' = veh, seat' = seat, seats' = seats, evt' = evt }
  action righted(v: str): bool = all { vst.get(v) == Righting, vst' = vst.set(v, Ok), st' = st, veh' = veh, seat' = seat, seats' = seats, evt' = evt }

  // match.ts stepVehicles seat loop: a seat whose kong no longer rides this vehicle in this seat is freed
  def keeps(v: str, k: int): bool = {
    val q = seats.get(v).get(k)
    riding(q) and veh.get(q) == v and seat.get(q) == k
  }
  action heal(v: str): bool = all {
    not(Set(Gone, Wreck, Sunk).contains(vst.get(v))),
    Seats.exists(k => seats.get(v).get(k) != NONE and not(keeps(v, k))),
    seats' = seats.set(v, Seats.mapBy(k => if (keeps(v, k)) seats.get(v).get(k) else NONE)),
    st' = st, veh' = veh, seat' = seat, vst' = vst, evt' = evt,
  }

  // spawnTuks + resetForMatch on everyone: a new fleet, every kong on foot
  action phase: bool = all {
    st' = Players.mapBy(_ => Ground),
    veh' = Players.mapBy(_ => NONE),
    seat' = Players.mapBy(_ => 0),
    vst' = Vehicles.mapBy(_ => Ok),
    seats' = Vehicles.mapBy(_ => EMPTY),
    evt' = Vehicles.mapBy(_ => false),
  }

  action step = {
    nondet p = Players.oneOf()
    nondet v = Vehicles.oneOf()
    nondet k = Seats.oneOf()
    any {
      getOut(p), die(p), respawn(p), enter(p, v), switchSeat(p, k),
      tip(v), sink(v), events(v), blow(v), clear(v), flip(v), righted(v), heal(v),
      phase,
    }
  }

  // ---- the rules

  // a seat names a kong exactly when that kong rides this vehicle in this seat (the two copies agree)
  val seatsAgree = Vehicles.forall(v => Seats.forall(k => Players.forall(p =>
    (seats.get(v).get(k) == p) iff (riding(p) and veh.get(p) == v and seat.get(p) == k))))

  // no dead kong holds a seat
  val noDeadRider = Vehicles.forall(v => Seats.forall(k =>
    if (seats.get(v).get(k) == NONE) true else st.get(seats.get(v).get(k)) != Dead))

  // one squad per vehicle
  val oneSquad = Vehicles.forall(v => Seats.forall(j => Seats.forall(k =>
    if (seats.get(v).get(j) == NONE or seats.get(v).get(k) == NONE) true
    else team(seats.get(v).get(j)) == team(seats.get(v).get(k)))))

  // a kong rides only a vehicle on its wheels, or one that has just gone over or under and is about to throw it out
  val rideOnWheels = Players.forall(p => if (riding(p)) (vst.get(veh.get(p)) == Ok or evt.get(veh.get(p))) else true)

  val all_rules = seatsAgree and noDeadRider and oneSquad and rideOnWheels
}
