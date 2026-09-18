import { racerId, type ChoiceId } from '../../ids.js';
import { option, racerTarget, type HookCtx } from '../hooks.js';
import type { RacerDef } from '../types.js';
import { FINISH } from '../../tracks/index.js';
import { defFor, isRunning } from './shared.js';

/**
 * The Dota set: sixteen heroes from Dota 2, designed in `docs/new-character-set.md`.
 *
 * Same conventions as the classic set: optional ("I can") powers ask and default to
 * declining, log lines name racers with `h.nameOf`, and one `h.log` per happening.
 *
 * Rulings the design doc leaves open, settled here:
 *
 *  - "Once per round" (Faceless Void, Silencer) means once per race: both are one-shot
 *    ultimates, used before the owner's main move.
 *  - "Skip my main move" powers (Earthshaker, Anti-Mage) are offered before the main move,
 *    and not at all on a tripped turn, which has no main move to skip.
 *  - A warp is not a move, so Storm Spirit passes nobody. It is still an arrival, though:
 *    "racers are stopped on a space after they've finished moving onto it, or otherwise
 *    arriving there by other means", so the space a warp lands on fires as usual.
 */

const def = defFor('dota');

// ---------------------------------------------------------------------------

/**
 * JINADA — "When I stop on a space with exactly one other racer, I steal 1 point from
 * them."
 *
 * Point chips only, like every power that takes points: cups are never touched. A victim
 * with no chips has nothing to steal, and a teammate isn't a victim.
 */
const bountyHunter = def(
  'bounty-hunter',
  'Bounty Hunter',
  'When I stop on a space with exactly one other racer, I steal 1 point from them.',
  {
    onStop: (h) => {
      if (!isRunning(h.self)) return;
      const sharing = h.sharing().filter(isRunning);
      const victim = sharing.length === 1 ? sharing[0] : undefined;
      if (!victim || victim.owner === h.self.owner) return;
      const stolen = h.forfeit(victim.owner, 1);
      if (stolen === 0) return;
      h.award(h.self.owner, stolen);
      h.log(`${h.nameOf(h.self)} picks ${h.nameOf(victim)}'s pocket: 1 point stolen.`);
    },
  },
);

/** GREATER BASH — "When I pass another racer, they roll a die. On a 1, they trip." */
const spiritBreaker = def(
  'spirit-breaker',
  'Spirit Breaker',
  'When I pass another racer, they roll a die. On a 1, they trip.',
  {
    onPass: (h, passed) => {
      if (!isRunning(passed)) return;
      const roll = h.rng.rollD6();
      h.log(
        roll === 1
          ? `${h.nameOf(h.self)} bashes ${h.nameOf(passed)}, who rolls a 1 and goes down!`
          : `${h.nameOf(h.self)} charges past ${h.nameOf(passed)}, who rolls a ${roll} and keeps their feet.`,
      );
      if (roll === 1) h.trip(passed);
    },
  },
);

/**
 * ECHO SLAM — "I can skip my main move to trip the other racers on my space, and move 2
 * for each racer I tripped."
 *
 * Only racers that actually go down count: one already tripped, or a Templar Assassin
 * shrugging it off, earns nothing.
 */
const earthshaker = def(
  'earthshaker',
  'Earthshaker',
  'I can skip my main move to trip the other racers on my space, and move 2 for each racer I tripped.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped) return;
      const targets = h.sharing().filter((r) => isRunning(r) && !r.tripped);
      if (targets.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: `Echo Slam? Trip the ${targets.length} other racer${targets.length === 1 ? '' : 's'} on your space instead of rolling.`,
        options: [
          option('slam', `Echo Slam (up to +${targets.length * 2})`),
          option('roll', 'Roll normally'),
        ],
        key: 'echoSlam',
        defaultChoice: 'roll' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'echoSlam' || choice !== ('slam' as ChoiceId)) return;
      h.skipMainMove();
      h.log(`${h.nameOf(h.self)} gives up the roll and slams the ground!`);
      let tripped = 0;
      for (const r of h.sharing().filter(isRunning)) if (h.trip(r)) tripped++;
      h.move(h.self, tripped * 2);
    },
  },
);

/** KRAKEN SHELL — "Each time I'm tripped, I roll a die. On a 4 or higher, I stand right back up." */
const tidehunter = def(
  'tidehunter',
  'Tidehunter',
  "Each time I'm tripped, I roll a die. On a 4 or higher, I stand right back up.",
  {
    onRacerTripped: (h, target) => {
      if (target.racerId !== h.self.racerId || !h.self.tripped) return;
      const roll = h.rng.rollD6();
      if (roll < 4) {
        h.log(`${h.nameOf(h.self)} rolls a ${roll} and stays down.`);
        return;
      }
      h.log(`${h.nameOf(h.self)} rolls a ${roll} and shrugs the trip off.`);
      h.self.tripped = false;
      h.emit({ t: 'racer/stoodUp', racerId: h.self.racerId });
    },
  },
);

/**
 * REFRACTION — "I ignore the first 3 trips I receive."
 *
 * Per race, like every power's memory. TRIP spaces count: a trip is a trip.
 */
const templarAssassin = def(
  'templar-assassin',
  'Templar Assassin',
  'I ignore the first 3 trips I receive.',
  {
    ignoresTrip: (h) => {
      const used = typeof h.self.memo['refractions'] === 'number' ? (h.self.memo['refractions'] as number) : 0;
      if (used >= 3) return false;
      h.self.memo['refractions'] = used + 1;
      const left = 3 - (used + 1);
      h.log(`${h.nameOf(h.self)}'s Refraction absorbs the trip (${left} left).`);
      return true;
    },
  },
);

/** BLINK — "I can skip my main move and warp to any space up to 3 ahead." */
const antiMage = def('anti-mage', 'Anti-Mage', 'I can skip my main move and warp to any space up to 3 ahead.', {
  beforeMainMove: (h) => {
    if (!isRunning(h.self) || h.self.tripped) return;
    const spaces = [...new Set([1, 2, 3].map((d) => Math.min(FINISH, h.self.pos + d)))].filter(
      (p) => p > h.self.pos,
    );
    if (spaces.length === 0) return;
    h.ask({
      player: h.self.owner,
      prompt: 'Blink instead of rolling?',
      options: [
        ...spaces.map((p) =>
          option(`blink:${p}`, p === FINISH ? 'Blink to the finish' : `Blink to space ${p}`, { t: 'space', index: p }),
        ),
        option('roll', 'Roll normally'),
      ],
      key: 'blink',
      defaultChoice: 'roll' as ChoiceId,
    });
  },
  resume: (h, key, choice) => {
    if (key !== 'blink' || choice === ('roll' as ChoiceId)) return;
    const pos = Number(String(choice).slice('blink:'.length));
    h.skipMainMove();
    h.log(`${h.nameOf(h.self)} blinks ${pos - h.self.pos} ahead.`);
    h.warp(h.self, pos);
  },
});

/**
 * CHRONOSPHERE — "Once per race, before my main move, I can trip every racer within 5
 * spaces of me."
 *
 * Either direction, teammates included — time stops for everyone in the bubble but me.
 */
const facelessVoid = def(
  'faceless-void',
  'Faceless Void',
  'Once per race, before my main move, I can trip every racer within 5 spaces of me.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.memo['chronoUsed'] === true) return;
      const caught = inBubble(h);
      if (caught.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: `Chronosphere? It catches ${caught.map((r) => h.nameOf(r)).join(', ')}. Once per race.`,
        options: [option('chrono', `Trip ${caught.length}`), option('wait', 'Not yet')],
        key: 'chrono',
        defaultChoice: 'wait' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'chrono' || choice !== ('chrono' as ChoiceId)) return;
      h.self.memo['chronoUsed'] = true;
      h.log(`${h.nameOf(h.self)} drops a Chronosphere!`);
      for (const r of inBubble(h)) h.trip(r);
    },
  },
);

/** Faceless Void's targets: running racers within 5 spaces that can still go down. */
function inBubble(h: HookCtx) {
  return h
    .running()
    .filter((r) => r.racerId !== h.self.racerId && !r.tripped && Math.abs(r.pos - h.self.pos) <= 5);
}

/**
 * GLOBAL SILENCE — "Once per race, before my main move, I can silence every other racer:
 * on their next turn, they have no powers and can only roll for their main move."
 *
 * Their whole turn, passive powers included, and nothing else: on everyone else's turns
 * their powers work as normal.
 */
const silencer = def(
  'silencer',
  'Silencer',
  'Once per race, before my main move, I can silence every other racer: on their next turn, they have no powers and can only roll for their main move.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.memo['silenceUsed'] === true) return;
      if (!h.running().some((r) => r.racerId !== h.self.racerId)) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Global Silence? Everyone else loses their powers on their next turn. Once per race.',
        options: [option('silence', 'Global Silence'), option('wait', 'Not yet')],
        key: 'silence',
        defaultChoice: 'wait' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'silence' || choice !== ('silence' as ChoiceId)) return;
      h.self.memo['silenceUsed'] = true;
      h.log(`${h.nameOf(h.self)} casts Global Silence. Nobody else has powers on their next turn.`);
      for (const r of h.running()) if (r.racerId !== h.self.racerId) h.silence(r);
    },
  },
);

/**
 * X MARKS THE SPOT — "After my main move, I can warp back to the space I started it on."
 *
 * Not from the finish line: a racer that has crossed it is done moving.
 */
const kunkka = def(
  'kunkka',
  'Kunkka',
  'After my main move, I can warp back to the space I started it on.',
  {
    afterMainMove: (h, from) => {
      if (!isRunning(h.self) || h.self.pos === from || h.self.pos === FINISH) return;
      h.ask({
        player: h.self.owner,
        prompt: `X marks the spot. Warp back to space ${from}?`,
        options: [
          option('return', `Back to space ${from}`, { t: 'space', index: from }),
          option('stay', `Stay on space ${h.self.pos}`),
        ],
        key: 'xMarks',
        data: { from },
        defaultChoice: 'stay' as ChoiceId,
      });
    },
    resume: (h, key, choice, data) => {
      if (key !== 'xMarks' || choice !== ('return' as ChoiceId)) return;
      const { from } = data as { from: number };
      h.log(`${h.nameOf(h.self)} is pulled back to the X.`);
      h.warp(h.self, from);
    },
  },
);

/** DEGEN AURA — "Other racers within 3 spaces of me get -2 to their main move." */
const omniknight = def(
  'omniknight',
  'Omniknight',
  'Other racers within 3 spaces of me get -2 to their main move.',
  {
    modifyMainMove: (h, value, mover) => {
      if (!isRunning(h.self) || mover.racerId === h.self.racerId) return value;
      if (Math.abs(mover.pos - h.self.pos) > 3) return value;
      const slowed = Math.max(0, value - 2);
      if (slowed !== value) h.log(`${h.nameOf(h.self)}'s aura slows ${h.nameOf(mover)}: -2.`);
      return slowed;
    },
  },
);

/** MULTICAST — "When I roll a 1 or 2 for my main move, I can take another turn after this one." */
const ogreMagi = def(
  'ogre-magi',
  'Ogre Magi',
  'When I roll a 1 or 2 for my main move, I can take another turn after this one.',
  {
    onMainRollFinal: (h, mover, value) => {
      if (mover.racerId !== h.self.racerId || (value !== 1 && value !== 2)) return;
      h.ask({
        player: h.self.owner,
        prompt: `You rolled a ${value}. Multicast — take another turn after this one?`,
        options: [option('multicast', 'Multicast!'), option('pass', 'No thanks')],
        key: 'multicast',
        defaultChoice: 'pass' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'multicast' || choice !== ('multicast' as ChoiceId)) return;
      h.log(`${h.nameOf(h.self)} multicasts! Another turn after this one.`);
      h.extraTurn();
    },
  },
);

/**
 * MORPH — "I have the power of any racer currently last. If there's a tie, I pick."
 *
 * Copy Cat's mirror image, and built the same way: no hooks here, because the board decides
 * them. See `characters/powers.ts`.
 */
const morphling = def(
  'morphling',
  'Morphling',
  "I have the power of any racer currently last. If there's a tie, I pick.",
  {},
);

/**
 * GREEVIL'S GREED — "I get double points from finish cups and star spaces."
 *
 * Only those two: point chips from powers, Bounty Hunter's loot included, stay as they are.
 */
const dotaAlchemist = def(
  'dota-alchemist',
  'Alchemist',
  'I get double points from finish cups and star spaces.',
  {
    modifyAward: (h, value, source) => {
      h.log(
        `${h.nameOf(h.self)}'s Greevil's Greed doubles the ${source === 'cup' ? 'cup' : 'star'}: ${value * 2} points.`,
      );
      return value * 2;
    },
  },
);

/**
 * DUEL — "After my main move, I can shout DUEL! at another racer on my space. We roll our
 * dice, and whoever rolls highest gets +1 to their main move for the rest of the race. I
 * win ties."
 */
const legionCommander = def(
  'legion-commander',
  'Legion Commander',
  'After my main move, I can shout DUEL! at another racer on my space. We roll our dice, and whoever rolls highest gets +1 to their main move for the rest of the race. I win ties.',
  {
    afterMainMove: (h) => {
      if (!isRunning(h.self) || h.self.pos === FINISH) return;
      const foes = h.sharing().filter(isRunning);
      if (foes.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Shout DUEL? The winner gets +1 to every main move this race.',
        options: [
          ...foes.map((r) => option(`duel:${r.racerId}`, `Duel ${h.nameOf(r)}`, racerTarget(r.racerId))),
          option('pass', 'Not now'),
        ],
        key: 'duel',
        defaultChoice: 'pass' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'duel' || choice === ('pass' as ChoiceId)) return;
      const foe = h.racers().find((r) => choice === (`duel:${r.racerId}` as ChoiceId));
      if (!foe || !isRunning(foe)) return;
      const mine = h.rng.rollD6();
      const theirs = h.rng.rollD6();
      // "I win ties."
      const winner = mine >= theirs ? h.self : foe;
      h.log(
        `DUEL! ${h.nameOf(h.self)} rolls ${mine}, ${h.nameOf(foe)} rolls ${theirs}. ` +
          `${h.nameOf(winner)} wins +1 to their main move for the rest of the race.`,
      );
      h.addMainMoveBonus(winner, 1);
    },
  },
);

/**
 * FALSE PROMISE — "At the start of my first turn, I predict which racer will trip first.
 * If I'm right, I get 3 points."
 *
 * The first trip after the prediction settles it, right or wrong. A trip shrugged off
 * never happened, so it settles nothing.
 */
const oracle = def(
  'oracle',
  'Oracle',
  "At the start of my first turn, I predict which racer will trip first. If I'm right, I get 3 points.",
  {
    beforeMainMove: (h) => {
      if (h.self.memo['prediction'] !== undefined || !isRunning(h.self)) return;
      h.self.memo['prediction'] = null;
      h.ask({
        player: h.self.owner,
        prompt: 'Who will trip first?',
        options: h.running().map((r) => option(`trip:${r.racerId}`, h.nameOf(r), racerTarget(r.racerId))),
        key: 'foresee',
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'foresee') return;
      const pick = String(choice).slice('trip:'.length);
      h.self.memo['prediction'] = pick;
      h.log(`${h.nameOf(h.self)} foresees ${h.nameOf(racerId(pick))} tripping first.`);
    },
    onRacerTripped: (h, target) => {
      const pick = h.self.memo['prediction'];
      if (typeof pick !== 'string' || h.self.memo['foreseen'] === true) return;
      h.self.memo['foreseen'] = true;
      if (target.racerId !== pick) return;
      h.log(`${h.nameOf(h.self)} saw it coming: ${h.nameOf(target)} tripped first. +3 points.`);
      h.award(h.self.owner, 3);
    },
  },
);

/**
 * BALL LIGHTNING — "All my moves are warps."
 *
 * Every move, not just the main one: an arrow, a Cheerleader's rally or a Centaur's kick
 * all teleport it. The pipeline does the warping; see `movesByWarp`.
 */
const stormSpirit = def('storm-spirit', 'Storm Spirit', 'All my moves are warps.', {
  movesByWarp: (h) => isRunning(h.self),
});

export const DOTA_RACERS: readonly RacerDef[] = [
  bountyHunter,
  spiritBreaker,
  earthshaker,
  tidehunter,
  templarAssassin,
  antiMage,
  facelessVoid,
  silencer,
  kunkka,
  omniknight,
  ogreMagi,
  morphling,
  dotaAlchemist,
  legionCommander,
  oracle,
  stormSpirit,
];
