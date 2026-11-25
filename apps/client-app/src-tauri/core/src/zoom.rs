use crate::ids::ServerId;
use std::collections::HashMap;

pub const LADDER: [u16; 17] = [
    25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
];
const DEFAULT_INDEX: usize = 7;

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
