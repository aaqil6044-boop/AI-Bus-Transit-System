"""Extract reference-complete roads around Bengaluru from the regional map."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'tools'))
import osmium

SOURCE = ROOT / 'southern-zone-latest.osm.pbf'
OUTPUT = ROOT / 'bengaluru.osm.pbf'
# Covers the metropolitan area including the airport and satellite towns.
WEST, SOUTH, EAST, NORTH = 77.20, 12.65, 78.00, 13.45


class AreaNodes(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.scanned = 0

    def node(self, node):
        self.scanned += 1
        if self.scanned % 5_000_000 == 0:
            print(f'Scanned {self.scanned:,} regional nodes...', flush=True)
        if node.location.valid() and (
            WEST <= node.location.lon <= EAST
            and SOUTH <= node.location.lat <= NORTH
        ):
            self.ids.add(node.id)


class AreaObjects(osmium.SimpleHandler):
    def __init__(self, nodes, writer):
        super().__init__()
        self.nodes = nodes
        self.ways = set()
        self.writer = writer

    def node(self, node):
        if node.id in self.nodes:
            self.writer.add_node(node)

    def way(self, way):
        if any(node.ref in self.nodes for node in way.nodes):
            self.ways.add(way.id)
            self.writer.add_way(way)

    def relation(self, relation):
        # Preserve local restrictions and multipolygon areas without pulling
        # nationwide administrative or public-transport relations into the map.
        if relation.tags.get('type') in ('restriction', 'multipolygon') and any(
            member.type == 'w' and member.ref in self.ways
            for member in relation.members
        ):
            self.writer.add_relation(relation)


if __name__ == '__main__':
    if OUTPUT.exists() and OUTPUT.stat().st_size > 0:
        print(f'Using existing city map: {OUTPUT}', flush=True)
        sys.exit(0)
    print('Selecting Bengaluru map nodes...', flush=True)
    nodes = AreaNodes()
    nodes.apply_file(str(SOURCE))
    print(f'Selected {len(nodes.ids):,} nodes. Extracting complete roads...', flush=True)
    with osmium.BackReferenceWriter(
        str(OUTPUT), str(SOURCE), remove_tags=False
    ) as writer:
        area = AreaObjects(nodes.ids, writer)
        area.apply_file(str(SOURCE))
        print(f'Selected {len(area.ways):,} ways. Resolving references...', flush=True)
    print(f'City map ready: {OUTPUT.stat().st_size / 1024**2:.1f} MB', flush=True)
