package com.minecraffai.mod;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.ToDoubleBiFunction;

public final class FollowPathfinderTest {
    private static int passed;

    private static final class Grid implements FollowPathfinder.Terrain {
        private final ToDoubleBiFunction<Integer, Integer> floor;
        private final Set<String> dangerous = new HashSet<>();
        private double ceiling = 100;
        private Grid(ToDoubleBiFunction<Integer, Integer> floor) { this.floor = floor; }

        public List<Double> standingHeights(int x, int z, double minY, double maxY) {
            if (Math.abs(x) > 20 || Math.abs(z) > 20 || dangerous.contains(x + ":" + z)) return List.of();
            double height = floor.applyAsDouble(x, z);
            if (!Double.isFinite(height) || height < minY || height > maxY || height + 1.8 > ceiling) return List.of();
            return List.of(height);
        }

        public boolean canTraverse(FollowPathfinder.Point from, FollowPathfinder.Point to) {
            // A low ceiling can block the jump even though both endpoints are standable.
            return Math.max(from.y(), to.y()) + (to.y() - from.y() > 0.6 ? 0.25 : 0) + 1.8 <= ceiling;
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static FollowPathfinder.Route route(Grid grid, double targetX, double targetY, double targetZ) {
        var start = new FollowPathfinder.Point(0, grid.floor.applyAsDouble(0, 0), 0);
        var route = FollowPathfinder.find(grid, start, targetX, targetY, targetZ, 0.1);
        var previous = start;
        for (var next : route.steps()) {
            check(Math.abs(next.x() - previous.x()) + Math.abs(next.z() - previous.z()) == 1, "route cuts a corner");
            check(FollowPathfinder.allowedHeightChange(previous.y(), next.y()), "route violates rise/fall limits");
            check(!grid.dangerous.contains(next.x() + ":" + next.z()), "route crosses a dangerous cell");
            previous = next;
        }
        check(route.visited() <= FollowPathfinder.MAX_VISITED, "search exceeded its budget");
        return route;
    }

    private static void scenario(String name, Runnable test) {
        test.run(); passed++; System.out.println("PASS " + name);
    }

    public static void main(String[] args) {
        scenario("flat floor", () -> check(route(new Grid((x, z) -> 0), 6.5, 0, 0.5).reachesTarget(), "flat route missing"));
        scenario("one-block ledge is climbed", () -> {
            var path = route(new Grid((x, z) -> x >= 1 ? 1 : 0), 4.5, 1, 0.5);
            check(path.reachesTarget() && path.steps().getFirst().y() == 1, "one-block jump not selected");
        });
        scenario("two-block wall is bypassed", () -> {
            var path = route(new Grid((x, z) -> x == 2 && Math.abs(z) <= 1 ? 2 : 0), 5.5, 0, 0.5);
            check(path.reachesTarget(), "wall detour missing");
            check(path.steps().stream().anyMatch(point -> Math.abs(point.z()) >= 2), "route did not go around wall");
            check(path.steps().stream().allMatch(point -> point.y() == 0), "route tried to jump two blocks");
        });
        scenario("successive steps can climb more than three blocks", () -> {
            var path = route(new Grid((x, z) -> Math.max(0, Math.min(x, 5))), 6.5, 5, 0.5);
            check(path.reachesTarget(), "old total-height restriction still applies");
        });
        scenario("half-block surfaces are preserved", () -> {
            var path = route(new Grid((x, z) -> Math.max(0, Math.min(x * 0.5, 2))), 5.5, 2, 0.5);
            check(path.reachesTarget() && path.steps().stream().anyMatch(point -> point.y() == 0.5), "slab height lost");
        });
        scenario("three-block drop is traversed", () -> {
            var path = route(new Grid((x, z) -> x >= 1 ? -3 : 0), 4.5, -3, 0.5);
            check(path.reachesTarget() && path.steps().getFirst().y() == -3, "three-block drop was refused");
        });
        scenario("fractional drop below four is traversed", () -> check(route(new Grid((x, z) -> x >= 1 ? -3.5 : 0), 4.5, -3.5, 0.5).reachesTarget(), "3.5-block drop refused"));
        scenario("exactly four-block drop is blocked", () -> check(!route(new Grid((x, z) -> x >= 1 ? -4 : 0), 4.5, -4, 0.5).reachesTarget(), "four-block drop allowed"));
        scenario("deeper cliff is bypassed", () -> {
            var path = route(new Grid((x, z) -> x == 2 && Math.abs(z) <= 1 ? -6 : 0), 5.5, 0, 0.5);
            check(path.reachesTarget() && path.steps().stream().allMatch(point -> point.y() == 0), "deep cliff not bypassed");
        });
        scenario("lava and unloaded landing cells are avoided", () -> {
            var grid = new Grid((x, z) -> x == 3 && z == 0 ? Double.NaN : 0);
            grid.dangerous.add("2:0");
            check(route(grid, 5.5, 0, 0.5).reachesTarget(), "safe detour missing");
        });
        scenario("low ceiling prevents a jump", () -> {
            var grid = new Grid((x, z) -> x >= 1 ? 1 : 0);
            grid.ceiling = 2.9;
            check(!route(grid, 4.5, 1, 0.5).reachesTarget(), "jump goes through low ceiling");
        });
        scenario("no route through a sealed wall", () -> check(!route(new Grid((x, z) -> x == 1 ? 3 : 0), 4.5, 0, 0.5).reachesTarget(), "sealed wall crossed"));
        scenario("distant target yields a bounded partial route", () -> {
            var path = route(new Grid((x, z) -> 0), 50.5, 0, 0.5);
            check(!path.reachesTarget() && !path.steps().isEmpty(), "partial route missing");
            check(path.steps().stream().allMatch(point -> Math.abs(point.x()) <= FollowPathfinder.SEARCH_RADIUS), "route exceeds local radius");
        });
        scenario("vertical separation does not count as holding distance", () -> {
            check(!FollowPathfinder.withinFollowDistance(0.5, 0, 0.5, 0.5, 3, 0.5, 3), "holding below a ledge");
            check(FollowPathfinder.withinFollowDistance(0.5, 0.5, 0.5, 2.5, 1, 0.5, 3), "normal holding distance rejected");
        });
        scenario("height boundaries and non-finite inputs", () -> {
            check(FollowPathfinder.allowedHeightChange(10, 11), "one-block rise rejected");
            check(!FollowPathfinder.allowedHeightChange(10, 12), "two-block rise allowed");
            check(FollowPathfinder.allowedHeightChange(10, 6.001), "drop below four rejected");
            check(!FollowPathfinder.allowedHeightChange(10, 6), "exactly four drop allowed");
            check(!FollowPathfinder.allowedHeightChange(10, Double.NaN), "invalid height allowed");
        });
        System.out.println(passed + " navigation scenarios passed");
    }
}
