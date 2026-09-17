import { racerId, type ChoiceId } from '../../ids.js';
import { option, racerTarget, type Hooks, type MutableRacer } from '../hooks.js';
import type { RacerDef } from '../types.js';
import { START } from '../../tracks/index.js';

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
];
