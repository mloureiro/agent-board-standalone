use crate::ids::ServerId;
use std::collections::HashMap;

pub const LADDER: [u16; 17] = [
    25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
];
const DEFAULT_INDEX: usize = 7;

pub const MENU_ZOOM_IN: &str = "zoom-in";
pub const MENU_ZOOM_IN_SHIFTED: &str = "zoom-in-shifted";
pub const MENU_ZOOM_OUT: &str = "zoom-out";
pub const MENU_ZOOM_RESET: &str = "zoom-reset";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    In,
    Out,
    Reset,
}

pub fn from_menu_id(id: &str) -> Option<Step> {
    match id {
        MENU_ZOOM_IN | MENU_ZOOM_IN_SHIFTED => Some(Step::In),
        MENU_ZOOM_OUT => Some(Step::Out),
        MENU_ZOOM_RESET => Some(Step::Reset),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Effect {
    Zoom { server: ServerId, factor: f64 },
}

#[derive(Default)]
pub struct Zoom {
    levels: HashMap<ServerId, usize>,
}

impl Zoom {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn percent(&self, server: ServerId) -> u16 {
        LADDER[self.index(server)]
    }

    pub fn factor(&self, server: ServerId) -> f64 {
        f64::from(self.percent(server)) / 100.0
    }

    pub fn zoom_in(&mut self, server: ServerId) -> Option<Effect> {
        let index = self.index(server);
        (index + 1 < LADDER.len()).then(|| self.set(server, index + 1))
    }

    pub fn zoom_out(&mut self, server: ServerId) -> Option<Effect> {
        let index = self.index(server);
        (index > 0).then(|| self.set(server, index - 1))
    }

    pub fn reset(&mut self, server: ServerId) -> Option<Effect> {
        (self.index(server) != DEFAULT_INDEX).then(|| self.set(server, DEFAULT_INDEX))
    }

    pub fn apply(&mut self, server: ServerId, step: Step) -> Option<Effect> {
        match step {
            Step::In => self.zoom_in(server),
            Step::Out => self.zoom_out(server),
            Step::Reset => self.reset(server),
        }
    }

    pub fn forget(&mut self, server: ServerId) {
        self.levels.remove(&server);
    }

    fn index(&self, server: ServerId) -> usize {
        self.levels.get(&server).copied().unwrap_or(DEFAULT_INDEX)
    }

    fn set(&mut self, server: ServerId, index: usize) -> Effect {
        self.levels.insert(server, index);
        Effect::Zoom {
            server,
            factor: self.factor(server),
        }
    }
}
