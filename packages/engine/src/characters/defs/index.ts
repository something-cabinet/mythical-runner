import { racerId, type ChoiceId } from '../../ids.js';
import { option, racerTarget, type Hooks, type MutableRacer } from '../hooks.js';
import type { RacerDef } from '../types.js';
import { START, trackForRace, type RaceNumber } from '../../tracks/index.js';

/**
 * Implemented racers.
 *
 * Power text is taken verbatim from `docs/magical-athlete-rules.md`, which is the
 * authority. Where a power is quoted in a comment, that quote is the card.
 *
 * These nine were chosen to cover every hook between them: a replaced main move, a
 * modified main move, a pass trigger on the passer, a pass trigger on the passed, a
 * stop trigger on self, a stop trigger on others, spatial displacement, and one power
 * that questions a player who is not taking the turn.
 *
 * The remaining 27 racers are vanilla padding until they are written. See the registry.
 */

function def(id: string, name: string, text: string, hooks: Hooks): RacerDef {
  return { id: racerId(id), name, text, hooks: hooks as unknown as Record<string, unknown> };
}

const isRunning = (r: MutableRacer): boolean => !r.eliminated && r.finishedRank === null;

// ---------------------------------------------------------------------------

/**
 * JOG — "I can skip rolling for my main move and move 5 instead."
 *
 * "CAN", so it is optional and must be asked. The note that "my power counts as my main
 * move" is why this is `replaceMainMove` rather than a separate move: it stays subject to
 * Gunk's goop and Coach's hustle.
 *
 * Asking before the roll would mean suspending inside `replaceMainMove`, which has to
 * return a number synchronously. Instead the choice is made in `beforeMainMove`, and the
 * answer is stashed in `memo` for `replaceMainMove` to read.
 */
const legs = def('legs', 'Legs', 'I can skip rolling for my main move and move 5 instead.', {
  beforeMainMove: (h) => {
    h.ask({
      player: h.self.owner,
      prompt: 'Jog exactly 5, or roll the die?',
      options: [option('jog', 'Jog 5'), option('roll', 'Roll normally')],
      key: 'jog',
      defaultChoice: 'roll' as ChoiceId,
    });
  },

  replaceMainMove: (h) => {
    const jogging = h.self.memo['jog'] === true;
    h.self.memo['jog'] = false;
    if (!jogging) return null;
    h.log('Legs skips the die and jogs exactly 5.');
    return 5;
  },

  resume: (h, key, choice) => {
    if (key !== 'jog') return;
    h.self.memo['jog'] = choice === ('jog' as ChoiceId);
  },
});

/** THE SLIP — "I trip any racer that passes me." */
const banana = def('banana', 'Banana', 'I trip any racer that passes me.', {
  onPassed: (h, passer) => {
    h.log(`${h.nameOf(passer)} slips on Banana!`);
    h.trip(passer);
  },
});

/**
 * HOOFWHACK — "When I pass a racer, they move -2."
 *
 * Mandatory, not optional. The card note caps the knockback: "A racer can't be
 * hoofwhacked any farther back than the Start space" — which `move` already enforces by
 * clamping at Start.
 */
const centaur = def('centaur', 'Centaur', 'When I pass a racer, they move -2.', {
  onPass: (h, passed) => {
    if (!isRunning(passed)) return;
    h.log(`Centaur hoofwhacks ${h.nameOf(passed)} back 2!`);
    h.move(passed, -2);
  },
});

/**
 * REALLY HUGE — "No one can ever be on my space, besides the Start. Whenever that would
 * happen, put the racer on the space behind me instead."
 *
 * Not a blocker that halts movement: the racer completes its move and is then displaced
 * one space back. The card is explicit that this "doesn't count as a move: it's like they
 * just stopped on that space instead", so the pipeline relocates without emitting a move.
 */
const hugeBaby = def(
  'huge-baby',
  'Huge Baby',
  'No one can ever be on my space, besides the Start. Whenever that would happen, put the racer on the space behind me instead.',
  {
    blocksSpace: (h, mover) => h.self.pos !== START && isRunning(mover),
  },
);

/**
 * CHOMP — "When I stop on a space with exactly one other racer, they're eliminated from
 * the race."
 *
 * Fires when M.O.U.T.H. stops, not when someone lands on it, and only at exactly one
 * other racer — a crowd is safe.
 */
const mouth = def(
  'mouth',
  'M.O.U.T.H.',
  "When I stop on a space with exactly one other racer, they're eliminated from the race.",
  {
    onStop: (h) => {
      const sharing = h.sharing().filter(isRunning);
      if (sharing.length !== 1) return;
      const victim = sharing[0];
      if (!victim) return;
      h.log(`M.O.U.T.H. chomps ${h.nameOf(victim)}!`);
      h.eliminate(victim);
    },
  },
);

/**
 * LEG IT — "Trip any racer that stops on my space, or when I stop on theirs."
 *
 * Symmetric, so both stop hooks are needed: `onOtherStops` for racers arriving on Baba
 * Yaga, `onStop` for Baba Yaga arriving on them.
 */
const babaYaga = def(
  'baba-yaga',
  'Baba Yaga',
  'Trip any racer that stops on my space, or when I stop on theirs.',
  {
    onOtherStops: (h, other) => {
      if (other.pos !== h.self.pos || !isRunning(other)) return;
      h.log(`${h.nameOf(other)} gets legged by Baba Yaga!`);
      h.trip(other);
    },
    onStop: (h) => {
      for (const other of h.sharing()) {
        if (!isRunning(other)) continue;
        h.log(`Baba Yaga legs it onto ${h.nameOf(other)}!`);
        h.trip(other);
      }
    },
  },
);

/**
 * D'AWW — "Before my main move, I get 1 point chip if I'm alone in last place."
 *
 * "Alone" is the rulebook's term for not sharing a space, and is a separate condition from
 * being in last place — a tie for last on the same space scores nothing.
 */
const lovableLoser = def(
  'lovable-loser',
  'Lovable Loser',
  "Before my main move, I get 1 point chip if I'm alone in last place.",
  {
    beforeMainMove: (h) => {
      const last = h.lastPlace();
      if (last.length !== 1 || last[0]?.racerId !== h.self.racerId) return;
      if (!h.alone()) return;
      h.log("Lovable Loser is alone in last place, and proud of it. +1 point.");
      h.award(h.self.owner, 1);
    },
  },
);

/**
 * DUEL! — "Whenever a racer shares my space, I can shout DUEL! We roll our dice and
 * whoever rolls highest moves 2. I win ties."
 *
 * The important one for the architecture: it is optional, it is the *Duelist's* choice
 * rather than the victim's, and it can fire when it is not the Duelist's turn — so the
 * question goes to a player who is not the active one. The winner moves forward 2; there
 * is no penalty for losing.
 *
 * The card's "I can duel multiple times in a turn" is honoured by triggering on every stop
 * that results in sharing, rather than once per turn.
 */
const duelist = def(
  'duelist',
  'Duelist',
  'Whenever a racer shares my space, I can shout DUEL! We roll our dice and whoever rolls highest moves 2. I win ties.',
  {
    onOtherStops: (h, other) => {
      if (other.pos !== h.self.pos || !isRunning(other) || !isRunning(h.self)) return;
      h.ask({
        player: h.self.owner,
        prompt: `${h.nameOf(other)} is sharing your space. Shout DUEL?`,
        options: [
          option('duel', 'DUEL!', racerTarget(other.racerId)),
          option('pass', 'Let them by'),
        ],
        key: 'duel',
        data: { target: other.racerId },
        defaultChoice: 'pass' as ChoiceId,
      });
    },

    onStop: (h) => {
      const target = h.sharing().find(isRunning);
      if (!target || !isRunning(h.self)) return;
      h.ask({
        player: h.self.owner,
        prompt: `You've landed on ${h.nameOf(target)}. Shout DUEL?`,
        options: [
          option('duel', 'DUEL!', racerTarget(target.racerId)),
          option('pass', 'Sheathe your rapier'),
        ],
        key: 'duel',
        data: { target: target.racerId },
        defaultChoice: 'pass' as ChoiceId,
      });
    },

    resume: (h, key, choice, data) => {
      if (key !== 'duel' || choice !== ('duel' as ChoiceId)) return;
      const targetId = (data as { target: string }).target;
      const target = h.racers().find((r) => r.racerId === targetId);
      if (!target || !isRunning(target)) return;

      const mine = h.rng.rollD6();
      const theirs = h.rng.rollD6();
      h.log(`DUEL! Duelist rolls ${mine}, ${h.nameOf(target)} rolls ${theirs}.`);

      // "I win ties."
      if (mine >= theirs) {
        h.log('Duelist wins the duel and advances 2.');
        h.move(h.self, 2);
      } else {
        h.log(`${h.nameOf(target)} wins the duel and advances 2.`);
        h.move(target, 2);
      }
    },
  },
);

/** GOOP 'EM — "Other racers get -1 to their main move." */
const gunk = def('gunk', 'Gunk', 'Other racers get -1 to their main move.', {
  modifyMainMove: (h, value) => {
    // The card is explicit that the goop "reduces the move amount, not the die roll
    // number", so it applies after the roll and can take a move below zero conceptually —
    // clamped at 0, since a negative main move is not a thing.
    if (!isRunning(h.self)) return value;
    const gooped = Math.max(0, value - 1);
    if (gooped !== value) h.log(`Gunk goops the track: -1.`);
    return gooped;
  },
});

/**
 * Phase 5, wave 1 — racers whose powers fit the existing hook set, plus five hooks added
 * alongside them: `skipsMainMove` (Hare), `onAnyMainMoveRolled` (Inchworm, Lackey,
 * Skipper), `onOtherTurnEnd` (Heckler), `skipsOccupiedSpaces` (Leaptoad), `onOtherMoveStart`
 * (Suckerfish), and `blocksOvershoot` (Stickler). `modifyMainMove` also grew a `mover`
 * parameter, since Coach and Blimp need to know whose roll they're adjusting.
 *
 * Wave 2 (not yet written) needs real engine additions: reroll (Dicemonger, Magician),
 * a postponed/extra turn (Genius), power-copying (Copy Cat, Egg, Twin), a race-ending
 * override (Mastermind), and a global "an ability just happened" counter (Scoocher).
 * Alchemist, Rocket Scientist and Sisyphus also want a post-roll decision point that
 * doesn't exist yet. See docs/STATUS.md.
 */

/** COACH — "Everyone on my space gets +1 to their main move, including me." */
const coach = def('coach', 'Coach', 'Everyone on my space gets +1 to their main move, including me.', {
  modifyMainMove: (h, value, mover) => {
    if (!isRunning(h.self) || mover.pos !== h.self.pos) return value;
    h.log(`Coach hustles ${h.nameOf(mover)}: +1.`);
    return value + 1;
  },
});

/**
 * RAH RAH — "Before my main move, I can make the racer(s) in last place move 2. If I do,
 * I move 1."
 *
 * "If I cheer for myself, those are two separate moves: move 2 then move 1" — so the bonus
 * is queued *before* the cheer, since `move` puts each new job at the front of the queue
 * and the last one queued runs first.
 */
const cheerleader = def(
  'cheerleader',
  'Cheerleader',
  "Before my main move, I can make the racer(s) in last place move 2. If I do, I move 1.",
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self)) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Cheer on last place? They move 2 and you move 1.',
        options: [option('cheer', 'Rah rah!'), option('pass', 'Stay quiet')],
        key: 'cheer',
        defaultChoice: 'pass' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'cheer' || choice !== ('cheer' as ChoiceId)) return;
      h.log('Cheerleader rallies the back of the pack!');
      h.move(h.self, 1);
      for (const r of h.lastPlace()) h.move(r, 2);
    },
  },
);

/**
 * HUBRIS — "I get +2 to my main move. When I start my turn alone in the lead, I skip my
 * main move."
 */
const hare = def('hare', 'Hare', 'I get +2 to my main move. When I start my turn alone in the lead, I skip my main move.', {
  skipsMainMove: (h) => {
    if (!isRunning(h.self)) return false;
    const lead = h.lead();
    if (lead.length !== 1 || lead[0]?.racerId !== h.self.racerId) return false;
    h.log('Hare is alone in the lead and struts past this turn.');
    return true;
  },
  modifyMainMove: (h, value, mover) => {
    if (mover.racerId !== h.self.racerId) return value;
    return value + 2;
  },
});

/**
 * SCHADENFREUDE — "When a racer ends their turn within 1 space of where they started, I
 * move 2."
 *
 * Fires for both self and others, matching Romantic's dual-hook pattern for "anyone".
 */
const heckler = def(
  'heckler',
  'Heckler',
  'When a racer ends their turn within 1 space of where they started, I move 2.',
  {
    onTurnEnd: (h) => {
      if (!isRunning(h.self)) return;
      if (Math.abs(h.self.pos - h.state.turnStartPos) > 1) return;
      h.log('Heckler heckles himself for barely moving: +2.');
      h.move(h.self, 2);
    },
    onOtherTurnEnd: (h, other, startPos) => {
      if (!isRunning(h.self) || !isRunning(other)) return;
      if (Math.abs(other.pos - startPos) > 1) return;
      h.log(`Heckler heckles ${h.nameOf(other)} for barely moving: +2.`);
      h.move(h.self, 2);
    },
  },
);

/** WRIGGLE — "When another racer rolls a 1 for their main move, they skip that move and I move 1." */
const inchworm = def(
  'inchworm',
  'Inchworm',
  'When another racer rolls a 1 for their main move, they skip that move and I move 1.',
  {
    onAnyMainMoveRolled: (h, mover, rolled) => {
      if (!isRunning(h.self) || mover.racerId === h.self.racerId || rolled !== 1) return;
      h.log(`${h.nameOf(mover)} rolls a 1 — Inchworm wriggles 1 and they skip it!`);
      h.move(h.self, 1);
      return 0;
    },
  },
);

/** VERY GOOD SIRE — "When another racer rolls a 6 for their main move, I move 2 before they move." */
const lackey = def(
  'lackey',
  'Lackey',
  'When another racer rolls a 6 for their main move, I move 2 before they move.',
  {
    onAnyMainMoveRolled: (h, mover, rolled) => {
      if (!isRunning(h.self) || mover.racerId === h.self.racerId || rolled !== 6) return;
      h.log(`${h.nameOf(mover)} rolls a 6 — Lackey cheers and moves 2!`);
      h.move(h.self, 2);
    },
  },
);

/**
 * SALTY DOG — "When anyone rolls a 1 for their main move, I go next in turn order."
 *
 * Doesn't fire on Skipper's own roll — he's already going.
 */
const skipper = def('skipper', 'Skipper', 'When anyone rolls a 1 for their main move, I go next in turn order.', {
  onAnyMainMoveRolled: (h, mover, rolled) => {
    if (!isRunning(h.self) || mover.racerId === h.self.racerId || rolled !== 1) return;
    h.log('Skipper cuts in line!');
    h.cutInLine();
  },
});

/** JUMPFROG — "While moving, I skip spaces with other racers on them." */
const leaptoad = def('leaptoad', 'Leaptoad', 'While moving, I skip spaces with other racers on them.', {
  skipsOccupiedSpaces: (h) => isRunning(h.self),
});

/**
 * ANIMAL MAGNETISM — "Before my main move, all racers move 1 space towards me. Each other
 * racer on my space gives me +1 to my main move."
 */
const partyAnimal = def(
  'party-animal',
  'Party Animal',
  'Before my main move, all racers move 1 space towards me. Each other racer on my space gives me +1 to my main move.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self)) return;
      for (const r of h.running()) {
        if (r.racerId === h.self.racerId) continue;
        if (r.pos < h.self.pos) h.move(r, 1);
        else if (r.pos > h.self.pos) h.move(r, -1);
      }
    },
    modifyMainMove: (h, value, mover) => {
      if (!isRunning(h.self) || mover.racerId !== h.self.racerId) return value;
      const bonus = h.sharing().filter(isRunning).length;
      if (bonus > 0) h.log(`Party Animal draws a crowd: +${bonus}.`);
      return value + bonus;
    },
  },
);

/** AH, LOVE! — "When anyone stops on a space with exactly one other racer, I move 2." */
const romantic = def(
  'romantic',
  'Romantic',
  'When anyone stops on a space with exactly one other racer, I move 2.',
  {
    onStop: (h) => {
      if (!isRunning(h.self)) return;
      if (h.at(h.self.pos).filter(isRunning).length !== 2) return;
      h.log('Romantic swoons at the sight of a pair: +2.');
      h.move(h.self, 2);
    },
    onOtherStops: (h, other) => {
      if (!isRunning(h.self) || !isRunning(other)) return;
      if (h.at(other.pos).filter(isRunning).length !== 2) return;
      h.log(`Romantic swoons watching ${h.nameOf(other)} pair up: +2.`);
      h.move(h.self, 2);
    },
  },
);

/**
 * SUCKER! — "When a racer on my space moves, I can move to their new space."
 *
 * `distance`/`dir` describe the mover's move at the moment it's queued; following with the
 * same signed distance from the same starting space lands Suckerfish on the mover's final
 * space regardless of what happens to the mover mid-move.
 */
const suckerfish = def('suckerfish', 'Suckerfish', 'When a racer on my space moves, I can move to their new space.', {
  onOtherMoveStart: (h, mover, distance) => {
    if (!isRunning(h.self) || !isRunning(mover)) return;
    h.ask({
      player: h.self.owner,
      prompt: `${h.nameOf(mover)} is moving off your space. Latch on?`,
      options: [
        option('follow', 'Sucker!', racerTarget(mover.racerId)),
        option('stay', 'Stay put'),
      ],
      key: 'follow',
      data: { distance },
      defaultChoice: 'stay' as ChoiceId,
    });
  },
  resume: (h, key, choice, data) => {
    if (key !== 'follow' || choice !== ('follow' as ChoiceId)) return;
    const { distance } = data as { distance: number };
    h.log('Suckerfish latches on and follows!');
    h.move(h.self, distance);
  },
});

/**
 * ACTUALLY... — "Other racers can only cross the finish line by moving the exact number of
 * spaces they need. If they overshoot, they don't move."
 */
const stickler = def(
  'stickler',
  'Stickler',
  "Other racers can only cross the finish line by moving the exact number of spaces they need. If they overshoot, they don't move.",
  {
    blocksOvershoot: (h) => isRunning(h.self),
  },
);

/** HSSSSST — "Before my main move, I can warp a racer to my space." */
const hypnotist = def('hypnotist', 'Hypnotist', 'Before my main move, I can warp a racer to my space.', {
  beforeMainMove: (h) => {
    if (!isRunning(h.self)) return;
    const targets = h.running().filter((r) => r.racerId !== h.self.racerId && r.pos !== h.self.pos);
    if (targets.length === 0) return;
    h.ask({
      player: h.self.owner,
      prompt: 'Hypnotize a racer to your space?',
      options: [
        ...targets.map((r) => option(`warp:${r.racerId}`, h.nameOf(r), racerTarget(r.racerId))),
        option('pass', 'Do nothing'),
      ],
      key: 'hypnotize',
      defaultChoice: 'pass' as ChoiceId,
    });
  },
  resume: (h, key, choice) => {
    if (key !== 'hypnotize' || choice === ('pass' as ChoiceId)) return;
    const target = h
      .running()
      .find((r) => choice === (`warp:${r.racerId}` as ChoiceId));
    if (!target) return;
    h.log(`Hypnotist hssssts ${h.nameOf(target)} over!`);
    h.warp(target, h.self.pos);
  },
});

/** ROLL THROUGH — "Before my main move, I can warp to any space with exactly 2 racers on it." */
const thirdWheel = def(
  'third-wheel',
  'Third Wheel',
  'Before my main move, I can warp to any space with exactly 2 racers on it.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self)) return;
      const counts = new Map<number, number>();
      for (const r of h.running()) counts.set(r.pos, (counts.get(r.pos) ?? 0) + 1);
      const spaces = [...counts.entries()]
        .filter(([pos, n]) => n === 2 && pos !== h.self.pos)
        .map(([pos]) => pos);
      if (spaces.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Warp to a pair of racers?',
        options: [
          ...spaces.map((pos) => option(`warp:${pos}`, `Space ${pos}`, { t: 'space', index: pos })),
          option('pass', 'Stay put'),
        ],
        key: 'thirdWheel',
        defaultChoice: 'pass' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'thirdWheel' || choice === ('pass' as ChoiceId)) return;
      const pos = Number(String(choice).slice('warp:'.length));
      h.log('Third Wheel rolls through and warps in!');
      h.warp(h.self, pos);
    },
  },
);

/**
 * FLOP FLIP — "I can skip rolling for my main move and swap spaces with another racer
 * instead."
 *
 * The swap is a pair of warps performed inside `replaceMainMove`, returning 0 so it costs
 * no movement of its own — a warp "doesn't count as moving", so this stays out of the pass
 * and modifier machinery built for an actual main move distance.
 */
const flipFlop = def(
  'flip-flop',
  'Flip Flop',
  'I can skip rolling for my main move and swap spaces with another racer instead.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self)) return;
      const partners = h.running().filter((r) => r.racerId !== h.self.racerId && r.pos !== h.self.pos);
      if (partners.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Flop flip: swap spaces with another racer instead of rolling?',
        options: [
          ...partners.map((r) => option(`swap:${r.racerId}`, `Swap with ${h.nameOf(r)}`, racerTarget(r.racerId))),
          option('roll', 'Roll normally'),
        ],
        key: 'flipFlop',
        defaultChoice: 'roll' as ChoiceId,
      });
    },
    replaceMainMove: (h) => {
      const partnerId = h.self.memo['flipFlopTarget'] as string | undefined;
      h.self.memo['flipFlopTarget'] = undefined;
      if (!partnerId) return null;
      const partner = h.racers().find((r) => r.racerId === racerId(partnerId));
      if (!partner || !isRunning(partner)) return null;
      const mine = h.self.pos;
      const theirs = partner.pos;
      h.warp(h.self, theirs);
      h.warp(partner, mine);
      h.log(`Flip Flop and ${h.nameOf(partner)} flop flip!`);
      return 0;
    },
    resume: (h, key, choice) => {
      if (key !== 'flipFlop' || choice === ('roll' as ChoiceId)) return;
      h.self.memo['flipFlopTarget'] = String(choice).slice('swap:'.length);
    },
  },
);

/**
 * BLOW IT — "When I start my turn before the second corner of the track, I get +3 to my
 * main move. On or after that corner, I get -1."
 *
 * `self.pos` at `modifyMainMove` time is still where the turn started — no movement has
 * happened yet this turn — so it doubles as "when I start my turn" without needing to read
 * `turnStartPos` separately.
 */
const blimp = def(
  'blimp',
  'Blimp',
  'When I start my turn before the second corner of the track, I get +3 to my main move. On or after that corner, I get -1.',
  {
    modifyMainMove: (h, value, mover) => {
      if (!isRunning(h.self) || mover.racerId !== h.self.racerId) return value;
      const phase = h.state.phase;
      if (phase.t !== 'racing') return value;
      const track = trackForRace(phase.raceNo as RaceNumber);
      const bonus = h.self.pos < track.secondCorner ? 3 : -1;
      h.log(bonus > 0 ? 'Blimp is cruising: +3.' : 'Blimp is past the corner and losing altitude: -1.');
      return value + bonus;
    },
  },
);

export const SLICE_RACERS: readonly RacerDef[] = [
  legs,
  banana,
  centaur,
  hugeBaby,
  mouth,
  babaYaga,
  lovableLoser,
  duelist,
  gunk,
  coach,
  cheerleader,
  hare,
  heckler,
  inchworm,
  lackey,
  skipper,
  leaptoad,
  partyAnimal,
  romantic,
  suckerfish,
  stickler,
  hypnotist,
  thirdWheel,
  flipFlop,
  blimp,
];
