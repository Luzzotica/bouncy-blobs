//! The 27 legacy levels converted to v3 (built into the binary).

pub struct Builtin {
    pub id: &'static str,
    pub name: &'static str,
    pub hidden: bool,
    pub json: &'static str,
}

pub const PARTY_LEVELS: &[Builtin] = &[
    Builtin { id: "classic", name: "Classic Race", hidden: false, json: include_str!("../../assets/levels/party/classic.json") },
    Builtin { id: "koth", name: "King of the Hill Arena", hidden: true, json: include_str!("../../assets/levels/party/koth.json") },
    Builtin { id: "koth-moving-test", name: "KOTH Moving Hill (test)", hidden: true, json: include_str!("../../assets/levels/party/koth-moving-test.json") },
    Builtin { id: "simple-koth", name: "Simple King of the Hill", hidden: false, json: include_str!("../../assets/levels/party/simple-koth.json") },
    Builtin { id: "blob-hill", name: "Blob Hill", hidden: false, json: include_str!("../../assets/levels/party/blob-hill.json") },
    Builtin { id: "default", name: "Default Arena", hidden: true, json: include_str!("../../assets/levels/party/default.json") },
    Builtin { id: "showcase", name: "Showcase Arena", hidden: true, json: include_str!("../../assets/levels/party/showcase.json") },
    Builtin { id: "playground", name: "Physics Playground", hidden: true, json: include_str!("../../assets/levels/party/playground.json") },
    Builtin { id: "det-test", name: "Determinism Test Arena", hidden: true, json: include_str!("../../assets/levels/party/det-test.json") },
    Builtin { id: "simple-race", name: "Simple Race", hidden: false, json: include_str!("../../assets/levels/party/simple-race.json") },
    Builtin { id: "chained-climb", name: "Chained Together", hidden: false, json: include_str!("../../assets/levels/party/chained-climb.json") },
    Builtin { id: "swervy", name: "Swervy", hidden: false, json: include_str!("../../assets/levels/party/swervy.json") },
    Builtin { id: "wall-climb", name: "Wall Climb", hidden: false, json: include_str!("../../assets/levels/party/wall-climb.json") },
    Builtin { id: "ceiling-crawl", name: "Ceiling Crawl", hidden: false, json: include_str!("../../assets/levels/party/ceiling-crawl.json") },
    Builtin { id: "moving-platforms", name: "Moving Platforms", hidden: false, json: include_str!("../../assets/levels/party/moving-platforms.json") },
    Builtin { id: "gravity-drive", name: "Gravity Drive", hidden: false, json: include_str!("../../assets/levels/party/gravity-drive.json") },
    Builtin { id: "springy", name: "Springy", hidden: false, json: include_str!("../../assets/levels/party/springy.json") },
    Builtin { id: "simple-king-of-the-hill", name: "Simple King of the Hill", hidden: false, json: include_str!("../../assets/levels/party/simple-king-of-the-hill.json") },
    Builtin { id: "jump", name: "Jump", hidden: false, json: include_str!("../../assets/levels/party/jump.json") },
    Builtin { id: "cannon", name: "Cannon", hidden: false, json: include_str!("../../assets/levels/party/cannon.json") },
    Builtin { id: "platforms-be-movin", name: "Platforms Be MOVIN", hidden: false, json: include_str!("../../assets/levels/party/platforms-be-movin.json") },
    Builtin { id: "squeeze-up", name: "Squeeze Up", hidden: false, json: include_str!("../../assets/levels/party/squeeze-up.json") },
    Builtin { id: "squeeze-in", name: "Squeeze In", hidden: false, json: include_str!("../../assets/levels/party/squeeze-in.json") },
    Builtin { id: "getting-crushed", name: "Getting Crushed", hidden: false, json: include_str!("../../assets/levels/party/getting-crushed.json") },
    Builtin { id: "crush-test", name: "Crush Test", hidden: true, json: include_str!("../../assets/levels/party/crush-test.json") },
    Builtin { id: "kids-playground", name: "Kids Playground", hidden: true, json: include_str!("../../assets/levels/party/kids-playground.json") },
    Builtin { id: "party", name: "Party Arena", hidden: true, json: include_str!("../../assets/levels/party/party.json") },
];

pub fn party_level(id: &str) -> Option<bb_level::Level> {
    PARTY_LEVELS.iter().find(|b| b.id == id).and_then(|b| bb_level::Level::from_json(b.json).ok())
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_parse() {
        for b in super::PARTY_LEVELS {
            assert!(super::party_level(b.id).is_some(), "{}", b.id);
        }
        assert_eq!(super::PARTY_LEVELS.len(), 27);
    }
}
