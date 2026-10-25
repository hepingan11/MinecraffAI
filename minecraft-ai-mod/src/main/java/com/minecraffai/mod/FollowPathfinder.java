package com.minecraffai.mod;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/** Bounded ground navigation. Minecraft collision/hazard checks belong to Terrain. */
public final class FollowPathfinder {
    public static final double MAX_RISE = 1.0;
    public static final double MAX_DROP = 4.0; // Exclusive: a four-block fall is not permitted.
    public static final double EPSILON = 0.0001;
    public static final int SEARCH_RADIUS = 12;
    public static final int MAX_VISITED = 512;

    public record Point(int x, double y, int z) {
        public double centerX() { return x + 0.5; }
        public double centerZ() { return z + 0.5; }
    }

    public interface Terrain {
        List<Double> standingHeights(int x, int z, double minY, double maxY);
        boolean canTraverse(Point from, Point to);
        default boolean allowHeightChange(double fromY, double toY) {
            return FollowPathfinder.allowedHeightChange(fromY, toY);
        }
        default double maxDrop() { return MAX_DROP; }
    }

    public record Route(List<Point> steps, boolean reachesTarget, int visited) {}
    private record Entry(Point point, double cost, double score) {}

    public static boolean allowedHeightChange(double fromY, double toY) {
        double rise = toY - fromY;
        return Double.isFinite(rise) && rise <= MAX_RISE + EPSILON && rise > -MAX_DROP + EPSILON;
    }

    public static boolean withinFollowDistance(double x, double y, double z, double targetX, double targetY, double targetZ, double distance) {
        return Math.hypot(x - targetX, z - targetZ) <= distance && Math.abs(y - targetY) <= 1.0;
    }

    private static double remaining(Point point, double x, double y, double z, double distance) {
        return Math.max(0, Math.hypot(point.centerX() - x, point.centerZ() - z) - distance)
            + Math.max(0, Math.abs(point.y - y) - 1.0) * 0.5;
    }

    public static Route find(Terrain terrain, Point start, double targetX, double targetY, double targetZ, double followDistance) {
        PriorityQueue<Entry> open = new PriorityQueue<>(Comparator.comparingDouble(Entry::score).thenComparingDouble(Entry::cost));
        Map<Point, Double> costs = new HashMap<>();
        Map<Point, Point> previous = new HashMap<>();
        double initialRemaining = remaining(start, targetX, targetY, targetZ, followDistance);
        open.add(new Entry(start, 0, initialRemaining));
        costs.put(start, 0.0);
        Point best = start;
        double bestRemaining = initialRemaining;
        int visited = 0;
        boolean reached = false;
        int[][] directions = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}};
        while (!open.isEmpty() && visited < MAX_VISITED) {
            Entry entry = open.poll();
            if (entry.cost > costs.getOrDefault(entry.point, Double.POSITIVE_INFINITY) + EPSILON) continue;
            Point current = entry.point;
            visited++;
            double left = remaining(current, targetX, targetY, targetZ, followDistance);
            if (left < bestRemaining - EPSILON) { best = current; bestRemaining = left; }
            if (withinFollowDistance(current.centerX(), current.y, current.centerZ(), targetX, targetY, targetZ, followDistance)) {
                best = current; reached = true; break;
            }
            for (int[] direction : directions) {
                int x = current.x + direction[0];
                int z = current.z + direction[1];
                if (Math.abs(x - start.x) > SEARCH_RADIUS || Math.abs(z - start.z) > SEARCH_RADIUS) continue;
                for (double height : terrain.standingHeights(x, z, current.y - terrain.maxDrop(), current.y + MAX_RISE)) {
                    if (!terrain.allowHeightChange(current.y, height)) continue;
                    Point next = new Point(x, height, z);
                    double cost = entry.cost + 1.0 + Math.abs(height - current.y) * 0.2;
                    if (cost + EPSILON >= costs.getOrDefault(next, Double.POSITIVE_INFINITY)) continue;
                    if (!terrain.canTraverse(current, next)) continue;
                    costs.put(next, cost);
                    previous.put(next, current);
                    open.add(new Entry(next, cost, cost + remaining(next, targetX, targetY, targetZ, followDistance)));
                }
            }
        }
        List<Point> steps = new ArrayList<>();
        for (Point point = best; !point.equals(start); point = previous.get(point)) steps.add(point);
        Collections.reverse(steps);
        return new Route(List.copyOf(steps), reached, visited);
    }
}
