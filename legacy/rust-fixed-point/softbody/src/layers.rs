// Collision-layer bitmask filter. Direct port of src/physics/layers.ts.
//
// Both sides must opt in for a collision to occur: a hits b iff
//   (a.layer & b.mask) != 0  AND  (b.layer & a.mask) != 0.

pub const LAYER_DEFAULT: u32 = 0b00000001;
pub const LAYER_BLOB:    u32 = 0b00000010;
pub const LAYER_CHAIN:   u32 = 0b00000100;
pub const LAYER_WORLD:   u32 = 0b00001000;

pub const LAYER_ALL: u32 = 0xFFFF;

#[inline]
pub const fn can_collide(layer_a: u32, mask_a: u32, layer_b: u32, mask_b: u32) -> bool {
    (layer_a & mask_b) != 0 && (layer_b & mask_a) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_blob_collide() {
        assert!(can_collide(LAYER_BLOB, LAYER_ALL, LAYER_WORLD, LAYER_ALL));
    }

    #[test]
    fn one_sided_filter_blocks() {
        // Chain wants only world; blob wants all.
        assert!(!can_collide(LAYER_BLOB, LAYER_ALL, LAYER_CHAIN, LAYER_WORLD));
        assert!(can_collide(LAYER_WORLD, LAYER_ALL, LAYER_CHAIN, LAYER_WORLD));
    }
}
