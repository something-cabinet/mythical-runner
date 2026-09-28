import { racerId, type ChoiceId } from '../../ids.js';
import { option, racerTarget, type HookCtx, type MutableRacer } from '../hooks.js';
import type { RacerDef } from '../types.js';
import { FINISH, START } from '../../tracks/index.js';
import { LEASH, MAIN_MOVE_BONUS, SOULBIND, timerLeft, TIMERS, type Soulbind } from '../powers.js';
import { defFor, isRunning } from './shared.js';

/**
 * The Dota set: forty-four heroes from Dota 2, designed in `docs/new-character-set.md`.
 *
 * Same conventions as the classic set: optional ("I can") powers ask and default to
 * declining, log lines name racers with `h.nameOf`, and one `h.log` per happening.
 *
 * Rulings the design doc leaves open, settled here:
 *
 *  - "Once per round" (Silencer) means once per race: a one-shot ultimate, cast before the
 *    owner's main move.
 *  - An "N-turn cooldown" (Faceless Void, Storm Spirit, Sven, Juggernaut, Grimstroke) counts the racer's own turns,
 *    tripped and silenced ones included: used on turn T, it is ready again on turn T+N.
 *    Kept as an engine timer (see `TIMERS`), which also times Sven's buff.
 *  - "Skip my main move" powers (Earthshaker, Anti-Mage, Ember Spirit, Underlord, Juggernaut) are offered before the main move,
 *    and not at all on a tripped turn, which has no main move to skip.
 *  - A warp is not a move, so a warped racer passes nobody. It is still an arrival, though:
 *    "racers are stopped on a space after they've finished moving onto it, or otherwise
 *    arriving there by other means", so the space a warp lands on fires as usual.
 *  - "Within N spaces near me" is a window of N spaces centred on the racer, not N spaces
 *    each way: 3 is my space and the one either side, 5 reaches two each way. See `near`.
 */

const def = defFor('dota');

/**
 * Whether `other` is in the `span`-space window centred on `self` — the design's "within
 * `span` spaces near me". Both directions; sharing the space counts.
 */
function near(self: { readonly pos: number }, other: { readonly pos: number }, span: 3 | 5): boolean {
  return Math.abs(other.pos - self.pos) <= (span - 1) / 2;
}

/** Starts `self`'s timer `name`: `turns` of its own turns, the current one included. */
function startTimer(h: HookCtx, name: string, turns: number): void {
  const timers = (h.self.memo[TIMERS] ?? {}) as Record<string, number>;
  h.self.memo[TIMERS] = { ...timers, [name]: turns };
}

// ---------------------------------------------------------------------------

/**
 * JINADA — "When I stop on a space with exactly one other racer, I steal 1 point from
 * them."
 *
 * Point chips only, like every power that takes points: cups are never touched, so a
 * victim holding nothing but cups keeps every point. The wording says "point chip" for
 * that reason. A victim with no chips has nothing to steal, and a teammate isn't a
 * victim.
 */
const bountyHunter = def(
  'bounty-hunter',
  'Bounty Hunter',
  'When I stop on a space with exactly one other racer, I steal 1 point chip from them. Cups are safe.',
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

/**
 * GREATER BASH — "When I pass another racer, they roll a die. On a 1, they trip."
 *
 * The victim's player throws it.
 */
const spiritBreaker = def(
  'spirit-breaker',
  'Spirit Breaker',
  'When I pass a racer, they roll a die. On a 1, they trip.',
  {
    onPass: (h, passed) => {
      if (!isRunning(passed)) return;
      h.askRoll(passed, {
        prompt: `${h.nameOf(h.self)} charges past ${h.nameOf(passed)}! Roll for ${h.nameOf(passed)}: on a 1, they trip.`,
        key: 'bash',
        data: { victim: passed.racerId },
      });
    },
    resume: (h, key, _choice, data) => {
      if (key !== 'bash') return;
      const victim = h.racers().find((r) => r.racerId === (data as { victim: string }).victim);
      if (!victim || !isRunning(victim)) return;
      const roll = h.rollDie(victim);
      h.log(
        roll === 1
          ? `${h.nameOf(h.self)} bashes ${h.nameOf(victim)}, who rolls a 1 and goes down!`
          : `${h.nameOf(h.self)} charges past ${h.nameOf(victim)}, who rolls a ${roll} and keeps their feet.`,
      );
      if (roll === 1) h.trip(victim);
    },
  },
);

/**
 * ECHO SLAM — "I can skip my main move to trip the other racers on my space, and move 2
 * for each racer I tripped."
 *
 * Only racers that actually go down count: one already tripped, or a Templar Assassin
 * shrugging it off, earns nothing.
 *
 * Never on the Start space: every racer begins there, so an opening slam would flatten
 * the whole field before anyone has moved.
 */
const earthshaker = def(
  'earthshaker',
  'Earthshaker',
  'I can skip my main move to trip every other racer on my space, then move 2 for each one I tripped. Not on the Start space.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped || h.self.pos === START) return;
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

/**
 * KRAKEN SHELL — "Each time I'm tripped, I roll a die. On a 4 or higher, I stand right back up."
 *
 * A trip can't stop the game, so the roll is deferred until the work that tripped me is
 * done, then asked for. Nothing to roll for if someone (Abaddon) already helped me up.
 */
const tidehunter = def(
  'tidehunter',
  'Tidehunter',
  "Each time I'm tripped, I roll a die. On a 4 or higher, I stand right back up.",
  {
    onRacerTripped: (h, target) => {
      if (target.racerId !== h.self.racerId || !h.self.tripped) return;
      h.defer('kraken');
    },
    resume: (h, key) => {
      if (!h.self.tripped || !isRunning(h.self)) return;
      if (key === 'kraken') {
        h.askRoll(h.self, {
          prompt: `${h.nameOf(h.self)} is down! Roll: on a 4 or higher, they stand right back up.`,
          key: 'krakenRoll',
        });
        return;
      }
      if (key !== 'krakenRoll') return;
      const roll = h.rollDie(h.self);
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
const antiMage = def('anti-mage', 'Anti-Mage', 'I can skip my main move to warp 1, 2 or 3 spaces ahead.', {
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
 * CHRONOSPHERE — "Before or after my main move, I can trip every racer within 2 spaces of
 * me. 5-turn cooldown."
 *
 * The design's 5-space bubble: my space and two either side. Either direction, teammates included — time stops for everyone in the bubble but me.
 * Asked twice a turn while it is ready: before the roll, and again once the main move
 * has landed, with the bubble counted from where I stand then. Not after a tripped turn
 * or a main move that went nowhere: there is no "after" to a move that never happened.
 */
const CHRONO_COOLDOWN = 5;
const facelessVoid = def(
  'faceless-void',
  'Faceless Void',
  `Before or after my main move, I can trip every racer within 2 spaces of me. Ready again ${CHRONO_COOLDOWN} turns later.`,
  {
    beforeMainMove: (h) => offerChrono(h, 'before'),
    afterMainMove: (h) => offerChrono(h, 'after'),
    resume: (h, key, choice) => {
      if (key !== 'chrono' || choice !== ('chrono' as ChoiceId)) return;
      startTimer(h, 'chrono', CHRONO_COOLDOWN);
      h.log(`${h.nameOf(h.self)} drops a Chronosphere!`);
      for (const r of inBubble(h)) h.trip(r);
    },
  },
  5,
);

/** Asks Faceless Void whether to drop the Chronosphere now, if it is ready and would catch anyone. */
function offerChrono(h: HookCtx, when: 'before' | 'after') {
  if (!isRunning(h.self) || timerLeft(h.self, 'chrono') > 0) return;
  const caught = inBubble(h);
  if (caught.length === 0) return;
  h.ask({
    player: h.self.owner,
    prompt: `Chronosphere ${when === 'before' ? 'before' : 'after'} your move? It catches ${caught.map((r) => h.nameOf(r)).join(', ')}. ${CHRONO_COOLDOWN}-turn cooldown.`,
    options: [
      option('chrono', `Trip ${caught.length}`),
      option('wait', when === 'before' ? 'Not yet — ask after my move' : 'Save it'),
    ],
    key: 'chrono',
    defaultChoice: 'wait' as ChoiceId,
  });
}

/** Faceless Void's targets: running racers in the 5-space bubble that can still go down. */
function inBubble(h: HookCtx) {
  return h
    .running()
    .filter((r) => r.racerId !== h.self.racerId && !r.tripped && near(h.self, r, 5));
}

/**
 * GLOBAL SILENCE — "Once per race, before my main move, I can silence every other racer.
 * I roll a die: for that many of their turns, they have no powers."
 *
 * Their whole turns, passive powers included, and nothing else: on everyone else's turns
 * their powers work as normal. Counted in each racer's own turns, tripped ones included.
 */
const silencer = def(
  'silencer',
  'Silencer',
  'Once per race, before my main move, I can silence every other racer. I roll a die: they have no powers for that many of their own turns.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.memo['silenceUsed'] === true) return;
      if (!h.running().some((r) => r.racerId !== h.self.racerId)) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Global Silence? Everyone else loses their powers — you roll for how many of their turns. Once per race.',
        options: [option('silence', 'Global Silence'), option('wait', 'Not yet')],
        key: 'silence',
        defaultChoice: 'wait' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key === 'silence') {
        if (choice !== ('silence' as ChoiceId)) return;
        h.self.memo['silenceUsed'] = true;
        h.askRoll(h.self, {
          prompt: 'Global Silence! Roll: that is how many turns everyone else goes without powers.',
          key: 'silenceRoll',
        });
        return;
      }
      if (key !== 'silenceRoll') return;
      const turns = h.rollDie(h.self);
      h.log(
        `${h.nameOf(h.self)} casts Global Silence and rolls a ${turns}: nobody else has powers for their next ${turns === 1 ? 'turn' : `${turns} turns`}.`,
      );
      for (const r of h.running()) if (r.racerId !== h.self.racerId) h.silence(r, turns);
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
  'After my main move, I can warp back to where I started it.',
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

/** DEGEN AURA — "Other racers on my space or next to it get -2 to their main move." */
const omniknight = def(
  'omniknight',
  'Omniknight',
  'Other racers on my space or next to it get -2 to their main move.',
  {
    modifyMainMove: (h, value, mover) => {
      if (!isRunning(h.self) || mover.racerId === h.self.racerId) return value;
      if (!near(h.self, mover, 3)) return value;
      const slowed = Math.max(0, value - 2);
      if (slowed !== value) h.log(`${h.nameOf(h.self)}'s aura slows ${h.nameOf(mover)}: -2.`);
      return slowed;
    },
  },
  3,
);

/**
 * FIREBLAST — "I roll two d3s and multiply them, so I move 1 to 9."
 *
 * For the main move only, rerolls included: a roll a power asks for, like a duel or Spirit
 * Breaker's bash, is one plain d6. Faces run 1, 2, 3, 4, 6 and 9 — never 5, 7 or 8.
 */
const ogreMagi = def(
  'ogre-magi',
  'Ogre Magi',
  'I roll two d3s and multiply them, so I move 1 to 9.',
  {
    throwDie: (h) => {
      const a = h.rng.roll(3);
      const b = h.rng.roll(3);
      h.log(`${h.nameOf(h.self)} rolls ${a} × ${b} = ${a * b}.`);
      return { face: a * b, sides: 3, dice: [a, b] };
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
  "I have the power of the racer in last place. If there's a tie, I pick.",
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
 * DUEL — "Whenever a racer shares my space, I can shout DUEL! We roll our dice, and
 * whoever rolls highest gets +1 to their main move for the rest of the race. I win ties."
 *
 * Both sides throw a plain d6, whatever their own die — no d20s, no Ogre Magi products —
 * and add the +1s they have already won from duels. No other main move modifier counts.
 *
 * Triggered like the Duelist's: on the stop that brings someone onto this space as well
 * as on Legion Commander's own, so it fires on another player's turn too and the question
 * goes to a player who is not the active one. Every stop that results in sharing offers
 * the duel again, so several are possible in a turn.
 */
const legionCommander = def(
  'legion-commander',
  'Legion Commander',
  'Whenever a racer shares my space, I can shout DUEL! We each roll a d6 and add our past duel wins. The winner gets +1 to their main move for the rest of the race. I win ties.',
  {
    onOtherStops: (h, other) => {
      if (!isRunning(h.self) || !isRunning(other) || other.pos !== h.self.pos) return;
      if (h.self.pos === FINISH) return;
      h.ask({
        player: h.self.owner,
        prompt: `${h.nameOf(other)} is sharing your space. Shout DUEL? The winner gets +1 to every main move this race.`,
        options: [
          option(`duel:${other.racerId}`, 'DUEL!', racerTarget(other.racerId)),
          option('pass', 'Not now'),
        ],
        key: 'duel',
        defaultChoice: 'pass' as ChoiceId,
      });
    },

    onStop: (h) => {
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
    // Each side throws its own die: the Commander's player first, then the foe's.
    resume: (h, key, choice, data) => {
      if (key === 'duel') {
        if (choice === ('pass' as ChoiceId)) return;
        const foe = h.racers().find((r) => choice === (`duel:${r.racerId}` as ChoiceId));
        if (!foe || !isRunning(foe)) return;
        h.askRoll(h.self, {
          prompt: `DUEL against ${h.nameOf(foe)}! Roll for ${h.nameOf(h.self)}.`,
          key: 'duelMine',
          data: { foe: foe.racerId },
        });
        return;
      }
      const { foe: foeId, mine: rolled, mineText } = data as { foe: string; mine?: number; mineText?: string };
      const foe = h.racers().find((r) => r.racerId === foeId);
      if (!foe || !isRunning(foe)) return;
      if (key === 'duelMine') {
        const mine = duelThrow(h, h.self);
        h.askRoll(foe, {
          prompt: `${h.nameOf(h.self)} rolled ${mine.text} in the DUEL. Roll for ${h.nameOf(foe)} — you need to beat it.`,
          key: 'duelTheirs',
          data: { foe: foeId, mine: mine.total, mineText: mine.text },
        });
        return;
      }
      if (key !== 'duelTheirs' || rolled === undefined) return;
      const mine = rolled;
      const theirs = duelThrow(h, foe);
      // "I win ties."
      const winner = mine >= theirs.total ? h.self : foe;
      h.log(
        `DUEL! ${h.nameOf(h.self)} rolls ${mineText ?? mine}, ${h.nameOf(foe)} rolls ${theirs.text}. ` +
        `${h.nameOf(winner)} wins +1 to their main move for the rest of the race.`,
      );
      h.addMainMoveBonus(winner, 1);
    },
  },
);

/**
 * One side's duel score: a plain d6 plus the +1s it has won from earlier duels. `text`
 * shows the sum when there is a bonus, e.g. "4 + 1 = 5".
 */
function duelThrow(h: HookCtx, racer: MutableRacer): { total: number; text: string } {
  const face = h.rollDie(racer, { plain: true });
  const had = racer.memo[MAIN_MOVE_BONUS];
  const bonus = typeof had === 'number' ? had : 0;
  const total = face + bonus;
  return { total, text: bonus === 0 ? String(face) : `${face} + ${bonus} = ${total}` };
}

/**
 * FATE'S EDICT — "Before my main move, I call odd or even. My main move gets +1 for each
 * correct call in my current streak. A miss resets it."
 *
 * Checked against the final die, after any rerolls. A hit adds one to the streak and the
 * whole streak to the move — +1, then +2, then +3 — and a miss sets it back to nothing.
 * A turn with no roll (tripped, or a move replaced by a power) calls nothing and leaves
 * the streak as it was.
 */
const oracle = def(
  'oracle',
  'Oracle',
  'Before my main move, I call odd or even. Each correct call in a row is worth 1 more: +1, then +2, then +3… A wrong call resets it.',
  {
    beforeMainMove: (h) => {
      delete h.self.memo['call'];
      delete h.self.memo['hit'];
      if (!isRunning(h.self) || h.self.tripped) return;
      const streak = oracleStreak(h.self);
      h.ask({
        player: h.self.owner,
        prompt: `Call it: odd or even? A hit is worth +${streak + 1}.`,
        options: [option('odd', 'Odd'), option('even', 'Even')],
        key: 'call',
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'call') return;
      h.self.memo['call'] = String(choice);
    },
    onMainRollFinal: (h, mover, value) => {
      const call = h.self.memo['call'];
      if (mover.racerId !== h.self.racerId || typeof call !== 'string') return;
      delete h.self.memo['call'];
      if ((value % 2 === 1 ? 'odd' : 'even') === call) {
        h.self.memo['streak'] = oracleStreak(h.self) + 1;
        h.self.memo['hit'] = true;
        return;
      }
      if (oracleStreak(h.self) > 0) h.log(`${h.nameOf(h.self)} called ${call} and missed: the streak is broken.`);
      delete h.self.memo['streak'];
    },
    modifyMainMove: (h, value, mover) => {
      if (mover.racerId !== h.self.racerId) return value;
      // Only on a hit: a streak carried from before waits for the next one.
      if (h.self.memo['hit'] !== true) return value;
      delete h.self.memo['hit'];
      const streak = oracleStreak(h.self);
      h.log(`${h.nameOf(h.self)} foresaw it: +${streak}.`);
      return value + streak;
    },
  },
);

/** Oracle's current run of correct calls. */
function oracleStreak(racer: MutableRacer): number {
  const streak = racer.memo['streak'];
  return typeof streak === 'number' ? streak : 0;
}

/**
 * OVERLOAD — "Before my main move, I can roll a d20 instead of a d6. 6-turn cooldown. While
 * it's recharging, I get -1 to my main move."
 *
 * Offered before the main move, and not on a tripped turn, which has no roll to swap. The
 * d20 is my die for the rest of that turn — a reroll throws it again — and the d6 is back
 * from the next. The d20 is a one-turn timer, so it lapses at the turn's end even if the
 * power was lost mid-turn to Doom's aura.
 *
 * The -1 is on the turns after the d20 until it's ready again, not on the d20 turn itself.
 */
const OVERLOAD_COOLDOWN = 6;
const stormSpirit = def(
  'storm-spirit',
  'Storm Spirit',
  `Before my main move, I can roll a d20 instead of my d6. Ready again ${OVERLOAD_COOLDOWN} turns later. Until then, I get -1 to my main move.`,
  {
    dieSides: (h) => (timerLeft(h.self, 'overloading') > 0 ? 20 : 6),
    modifyMainMove: (h, value, mover) => {
      if (mover.racerId !== h.self.racerId) return value;
      if (timerLeft(h.self, 'overload') === 0 || timerLeft(h.self, 'overloading') > 0) return value;
      h.log(`${h.nameOf(h.self)} is recharging: -1.`);
      return value - 1;
    },
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped || timerLeft(h.self, 'overload') > 0) return;
      h.ask({
        player: h.self.owner,
        prompt: `Overload? Roll a d20 instead of your d6 this turn. ${OVERLOAD_COOLDOWN}-turn cooldown.`,
        options: [option('overload', 'Roll the d20'), option('d6', 'Roll the d6')],
        key: 'overload',
        defaultChoice: 'd6' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'overload' || choice !== ('overload' as ChoiceId)) return;
      startTimer(h, 'overload', OVERLOAD_COOLDOWN);
      startTimer(h, 'overloading', 1);
      h.log(`${h.nameOf(h.self)} overloads: a d20 this turn!`);
    },
  },
);

/**
 * THIRST — "I get +1 to my main move for each other racer currently tripped."
 *
 * Counted as the move is settled, so a racer that went down earlier this turn counts.
 */
const bloodseeker = def(
  'bloodseeker',
  'Bloodseeker',
  'I get +1 to my main move for each other racer currently tripped.',
  {
    modifyMainMove: (h, value, mover) => {
      if (mover.racerId !== h.self.racerId) return value;
      const down = h.running().filter((r) => r.racerId !== h.self.racerId && r.tripped).length;
      if (down === 0) return value;
      h.log(`${h.nameOf(h.self)} smells blood: +${down}.`);
      return value + down;
    },
  },
);

/**
 * POWER COGS — "Before or after my main move, I push every racer 1 space away from me."
 *
 * Racers ahead move 1 forward, racers behind move 1 back; racers on my space have no "away"
 * and stay put. Each push is a move, so it can pass, and the space it ends on fires.
 * Once a turn, not optional: asked before the roll whether to push now or after, and "after"
 * pushes from wherever the main move lands. No main move, no "after" — the push is lost.
 */
const clockwerk = def(
  'clockwerk',
  'Clockwerk',
  'Before or after my main move, I push every racer 1 space away from me.',
  {
    beforeMainMove: (h) => {
      // A choice left over from a turn whose main move never happened is dropped.
      h.self.memo[COGS_AFTER] = false;
      if (!isRunning(h.self)) return;
      if (!h.running().some((r) => r.racerId !== h.self.racerId)) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Power Cogs: push every racer 1 away from you now, or after your move?',
        options: [option('now', 'Push now'), option('after', 'After my move')],
        key: 'cogs',
        defaultChoice: 'now' as ChoiceId,
      });
    },
    afterMainMove: (h) => {
      if (h.self.memo[COGS_AFTER] !== true) return;
      h.self.memo[COGS_AFTER] = false;
      if (isRunning(h.self)) powerCogs(h);
    },
    resume: (h, key, choice) => {
      if (key !== 'cogs') return;
      if (choice === ('after' as ChoiceId)) h.self.memo[COGS_AFTER] = true;
      else powerCogs(h);
    },
  },
);

const COGS_AFTER = 'cogsAfter';

/** Clockwerk pushes every racer not on its space 1 away from it. */
function powerCogs(h: HookCtx): void {
  const pushed = h
    .running()
    .filter((r) => r.racerId !== h.self.racerId && r.pos !== h.self.pos && r.pos !== START);
  // A racer on Start can't be pushed any further back.
  if (pushed.length === 0) return;
  h.log(`${h.nameOf(h.self)}'s Power Cogs push everyone 1 away.`);
  // Moves are queued at the front, so queue in reverse to push in board order.
  for (const r of [...pushed].reverse()) h.move(r, r.pos > h.self.pos ? 1 : -1);
}

/**
 * MEAT HOOK — "Before my main move, I can warp a racer to my space."
 *
 * Hypnotist's power under another name, and ruled the same way: any running racer not
 * already with me, my main move still follows, and nothing is rolled. A warp passes
 * nobody, but the racer does arrive: my space's effect and stop powers fire for them —
 * hook Baba Yaga and I'm the one who trips.
 */
const pudge = def('pudge', 'Pudge', 'Before my main move, I can warp any racer to my space.', {
  beforeMainMove: (h) => {
    if (!isRunning(h.self)) return;
    const targets = h.running().filter((r) => r.racerId !== h.self.racerId && r.pos !== h.self.pos);
    if (targets.length === 0) return;
    h.ask({
      player: h.self.owner,
      prompt: 'Meat Hook a racer to your space?',
      options: [
        ...targets.map((r) => option(`hook:${r.racerId}`, h.nameOf(r), racerTarget(r.racerId))),
        option('pass', 'Do nothing'),
      ],
      key: 'hook',
      defaultChoice: 'pass' as ChoiceId,
    });
  },
  resume: (h, key, choice) => {
    if (key !== 'hook' || choice === ('pass' as ChoiceId)) return;
    const victim = h.running().find((r) => choice === (`hook:${r.racerId}` as ChoiceId));
    if (!victim) return;
    h.log(`${h.nameOf(h.self)} hooks ${h.nameOf(victim)} over!`);
    h.warp(victim, h.self.pos);
  },
});

/**
 * PROXIMITY MINES — "Every space I stop on gets a mine. The next racer to stop there trips,
 * and the mine is gone."
 *
 * Mined as I come to rest, after the space has done whatever it does, so I don't trip on
 * the mine I've just laid — but the next racer to stop there sets it off, me included.
 * While it's armed, a star or an arrow under it does nothing; once it has gone off, the
 * space is its old self again. Start, the finish and TRIP spaces can't be mined.
 */
const techies = def(
  'techies',
  'Techies',
  'Every space I stop on gets a mine. The next racer to stop there trips, and the mine is gone.',
  {
    onStop: (h) => {
      if (!isRunning(h.self)) return;
      if (h.mineSpace(h.self.pos)) h.log(`${h.nameOf(h.self)} plants a mine on space ${h.self.pos}.`);
    },
  },
);

/**
 * CHAOS STRIKE — "I roll a d20, and get -8 to my main move. It can take me backwards."
 *
 * The d20 is my die for anything that has me roll: rerolls, a duel, Spirit Breaker's bash.
 * The -8 is only on the main move. Below 0 it runs backwards, clamped at Start; at exactly
 * 0 there is no move. Self modifiers apply last, so the -8 comes after everyone else's —
 * a Gunk can't clamp a backwards move to 0.
 */
const chaosKnight = def(
  'chaos-knight',
  'Chaos Knight',
  'I roll a d20 and get -8 to my main move, so I can go backwards.',
  {
    dieSides: () => 20,
    modifyMainMove: (h, value, mover) => {
      if (mover.racerId !== h.self.racerId) return value;
      h.log(`${h.nameOf(h.self)}'s Chaos Strike: -8.`);
      return value - 8;
    },
  },
);

/**
 * APHOTIC SHIELD — "Whenever another racer trips, I can help them up at once. If I do, I
 * move 3."
 *
 * Offered once the trip has settled, so a Tidehunter that shrugged it off by itself isn't
 * offered. A racer helped up is no longer tripped, and so doesn't skip its next main move.
 */
const abaddon = def(
  'abaddon',
  'Abaddon',
  'Whenever another racer trips, I can help them straight back up. If I do, I move 3.',
  {
    onRacerTripped: (h, target) => {
      if (target.racerId === h.self.racerId || !isRunning(h.self) || !isRunning(target)) return;
      h.defer('aphoticShield', { target: target.racerId });
    },
    resume: (h, key, choice, data) => {
      const { target: targetId } = (data ?? {}) as { target?: string };
      const target = h.racers().find((r) => r.racerId === targetId);
      if (!target || !isRunning(target) || !target.tripped || !isRunning(h.self)) return;
      if (key === 'aphoticShield') {
        h.ask({
          player: h.self.owner,
          prompt: `${h.nameOf(target)} is down. Help them up and move 3?`,
          options: [option('help', `Help ${h.nameOf(target)} up`, racerTarget(target.racerId)), option('pass', 'Leave them')],
          key: 'helpUp',
          data: { target: targetId },
          defaultChoice: 'pass' as ChoiceId,
        });
        return;
      }
      if (key !== 'helpUp' || choice !== ('help' as ChoiceId)) return;
      target.tripped = false;
      h.emit({ t: 'racer/stoodUp', racerId: target.racerId });
      h.log(`${h.nameOf(h.self)} helps ${h.nameOf(target)} up, and moves 3.`);
      h.move(h.self, 3);
    },
  },
);

/**
 * SLEIGHT OF FIST — "I can skip my main move to move 2 for each other racer on my space or
 * next to it."
 *
 * A dash through the pack: worth nothing out in front alone, and worth more than any roll
 * in traffic, so Ember Spirit wants to be where the crowd is — the opposite of Drow.
 *
 * Either direction, tripped racers and teammates included: the dash is measured by who is
 * nearby, not by who can be hit. Counted again when the answer comes back, so a racer that
 * moved in between counts as they stand.
 */
const emberSpirit = def(
  'ember-spirit',
  'Ember Spirit',
  'I can skip my main move to move 2 for each other racer on my space or next to it.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped) return;
      const crowd = inReach(h);
      if (crowd.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: `Sleight of Fist? ${crowd.length} racer${crowd.length === 1 ? ' is' : 's are'} on your space or next to it.`,
        options: [
          option('dash', `Sleight of Fist (+${crowd.length * 2})`),
          option('roll', 'Roll normally'),
        ],
        key: 'sleight',
        defaultChoice: 'roll' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'sleight' || choice !== ('dash' as ChoiceId)) return;
      const crowd = inReach(h);
      h.skipMainMove();
      if (crowd.length === 0) return;
      h.log(`${h.nameOf(h.self)} dashes through ${crowd.length} racer${crowd.length === 1 ? '' : 's'}: ${crowd.length * 2} spaces.`);
      h.move(h.self, crowd.length * 2);
    },
  },
  3,
);

/** Ember Spirit's crowd: running racers on its space or next to it, itself excluded. */
function inReach(h: HookCtx) {
  return h
    .running()
    .filter((r) => r.racerId !== h.self.racerId && near(h.self, r, 3));
}

/**
 * BOULDER SMASH — "Before my main move, I can kick one racer on my space 3 spaces forward
 * or backward."
 *
 * The direction is Earth Spirit's choice, which is the whole power: a kick backwards
 * buries a rival, a kick forwards is a favour — or a shove over the finish line, cup and
 * all. A kick is a move, so it can pass racers and the space it lands on fires.
 *
 * A racer already on Start has nowhere to go backwards, so only the forward kick is
 * offered for them.
 */
const earthSpirit = def(
  'earth-spirit',
  'Earth Spirit',
  'Before my main move, I can kick one racer on my space 3 spaces forward or back.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped) return;
      const targets = h.sharing().filter(isRunning);
      if (targets.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Boulder Smash? Kick one racer on your space 3 spaces.',
        options: [
          ...targets.flatMap((r) => [
            option(`smash:${r.racerId}:1`, `Kick ${h.nameOf(r)} 3 forward`, racerTarget(r.racerId)),
            ...(r.pos > START
              ? [option(`smash:${r.racerId}:-1`, `Kick ${h.nameOf(r)} 3 back`, racerTarget(r.racerId))]
              : []),
          ]),
          option('pass', 'Leave them be'),
        ],
        key: 'smash',
        defaultChoice: 'pass' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'smash' || choice === ('pass' as ChoiceId)) return;
      const [, targetId, dir] = String(choice).split(':');
      const target = h.racers().find((r) => r.racerId === racerId(String(targetId)));
      if (!target || !isRunning(target)) return;
      const distance = dir === '-1' ? -3 : 3;
      h.log(`${h.nameOf(h.self)} smashes ${h.nameOf(target)} 3 spaces ${distance < 0 ? 'back' : 'forward'}.`);
      h.move(target, distance);
    },
  },
);

/**
 * QUILL SPRAY — "If I trip, I also trip all racers on my space or next to it."
 *
 * The fall goes off like a spray of quills: anyone nearby goes down with me, either
 * direction, teammates included. Racers already down, or shrugging it off, are unaffected
 * — and since a racer that is already tripped can't be tripped again, the spray never
 * bounces back.
 */
const bristleback = def(
  'bristleback',
  'Bristleback',
  'If I trip, I also trip all racers on my space or next to it.',
  {
    onRacerTripped: (h, target) => {
      if (target.racerId !== h.self.racerId || !h.self.tripped) return;
      const caught = h
        .running()
        .filter((r) => r.racerId !== h.self.racerId && !r.tripped && near(h.self, r, 3));
      if (caught.length === 0) return;
      h.log(`${h.nameOf(h.self)} goes down in a spray of quills, taking ${caught.length} with it.`);
      for (const r of caught) h.trip(r);
    },
  },
  3,
);

/**
 * PRECISION AURA — "I use a d6. If no other racer is on my space or next to it, I use a d10
 * instead."
 *
 * Drow shoots best with room to work: crowded, the die is everyone else's; clear of the
 * pack, it is better. `dieSides` covers every roll of her die, so a duel or
 * a Spirit Breaker bash is rolled on whichever die the board says she has at that moment.
 */
const drowRanger = def(
  'drow-ranger',
  'Drow Ranger',
  'I roll a d10 instead of a d6 when no other racer is on my space or next to it.',
  {
    dieSides: (h) => {
      const crowded = h
        .running()
        .some((r) => r.racerId !== h.self.racerId && near(h.self, r, 3));
      return crowded ? 6 : 10;
    },
  },
  3,
);

/**
 * DARKNESS — "I get +2 to my main move on odd turns, and -1 on even turns."
 *
 * Night and day, counted in Night Stalker's *own* turns rather than the table's: a turn
 * counter shared with everyone would lock a seat onto one half of the cycle forever in a
 * two- or four-player game. The count runs per race and includes a turn lost to a trip —
 * the sun comes up whether or not you ran.
 */
const nightStalker = def(
  'night-stalker',
  'Night Stalker',
  'I get +2 to my main move on my odd turns, and -1 on my even turns.',
  {
    beforeMainMove: (h) => {
      const turns = typeof h.self.memo['nights'] === 'number' ? (h.self.memo['nights'] as number) : 0;
      h.self.memo['nights'] = turns + 1;
    },
    modifyMainMove: (h, value, mover) => {
      if (!isRunning(h.self) || mover.racerId !== h.self.racerId) return value;
      const turns = typeof h.self.memo['nights'] === 'number' ? (h.self.memo['nights'] as number) : 1;
      const night = turns % 2 === 1;
      h.log(night ? `Night falls for ${h.nameOf(h.self)}: +2.` : `Daylight catches ${h.nameOf(h.self)}: -1.`);
      return value + (night ? 2 : -1);
    },
  },
);

/**
 * ESSENCE SHIFT — "I get +1 to my main move for every silver cup, and +2 for every gold
 * cup."
 *
 * Cups my *owner* holds, from every race so far — so Slark is worthless in race 1 and
 * frightening in race 4 for whoever is winning. Point chips are not cups and count for
 * nothing.
 */
const slark = def(
  'slark',
  'Slark',
  'I get +1 to my main move for every silver cup, and +2 for every gold cup.',
  {
    modifyMainMove: (h, value, mover) => {
      if (!isRunning(h.self) || mover.racerId !== h.self.racerId) return value;
      const cups = h.state.scores[h.self.owner] ?? [];
      const bonus = cups.reduce((sum, t) => sum + (t.kind === 'gold' ? 2 : t.kind === 'silver' ? 1 : 0), 0);
      if (bonus === 0) return value;
      h.log(`${h.nameOf(h.self)} feeds on the trophy shelf: +${bonus}.`);
      return value + bonus;
    },
  },
);

/**
 * AETHER REMNANT — "Before my main move, I can move one other racer 1 space forward or
 * backward."
 *
 * A little nudge, anywhere on the board. It is a move, so it can pass a racer and the
 * space it lands on fires. Nobody on Start can go back, and nobody across the line is
 * running to be nudged.
 */
const voidSpirit = def(
  'void-spirit',
  'Void Spirit',
  'Before my main move, I can move any other racer 1 space forward or backward.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped) return;
      const targets = h.running().filter((r) => r.racerId !== h.self.racerId);
      if (targets.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Aether Remnant? Move one racer 1 space.',
        options: [
          ...targets.flatMap((r) => [
            option(`nudge:${r.racerId}:1`, `${h.nameOf(r)} 1 forward`, racerTarget(r.racerId)),
            ...(r.pos > START
              ? [option(`nudge:${r.racerId}:-1`, `${h.nameOf(r)} 1 back`, racerTarget(r.racerId))]
              : []),
          ]),
          option('pass', 'Leave everyone be'),
        ],
        key: 'nudge',
        defaultChoice: 'pass' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'nudge' || choice === ('pass' as ChoiceId)) return;
      const [, targetId, dir] = String(choice).split(':');
      const target = h.racers().find((r) => r.racerId === racerId(String(targetId)));
      if (!target || !isRunning(target)) return;
      const distance = dir === '-1' ? -1 : 1;
      h.log(`${h.nameOf(h.self)} shifts ${h.nameOf(target)} 1 space ${distance < 0 ? 'back' : 'forward'}.`);
      h.move(target, distance);
    },
  },
);

/**
 * CHAIN FROST — "After my main move, I pull everyone to my space."
 *
 * Not optional, and it means everyone: racers behind are pulled forward, racers ahead
 * dragged back, teammates too. Each pull is a move, so it can pass and the space fires —
 * which, with everyone landing on Lich's own space, is the same space for all. Not from
 * the finish line: that would haul the whole field over it.
 */
const lich = def('lich', 'Lich', 'After my main move, I pull every other racer to my space. Not from the finish line.', {
  afterMainMove: (h) => {
    if (!isRunning(h.self) || h.self.pos === FINISH) return;
    const pulled = h.running().filter((r) => r.racerId !== h.self.racerId && r.pos !== h.self.pos);
    if (pulled.length === 0) return;
    h.log(`${h.nameOf(h.self)} pulls everyone to space ${h.self.pos}.`);
    // Moves are queued at the front, so queue in reverse to pull in board order.
    for (const r of [...pulled].reverse()) h.move(r, h.self.pos - r.pos);
  },
});

/**
 * REVERSE POLARITY — "Before or after my main move, I can warp every racer within 5 spaces
 * to my space. 4-turn cooldown."
 *
 * "Within 5" is the usual window: my space and two either side. Warped, so it passes
 * nobody, but they arrive and my space fires for each. Asked twice a turn while it is
 * ready, like Chronosphere: before the roll, and again once the main move has landed, with
 * the window counted from where I stand then. Not from the finish line, which would carry
 * them over it. The cooldown counts my own turns like the others: used on turn T, ready
 * again on turn T+4.
 */
const POLARITY_COOLDOWN = 4;
const magnus = def(
  'magnus',
  'Magnus',
  `Before or after my main move, I can warp every racer within 5 spaces to my space. Ready again ${POLARITY_COOLDOWN} turns later.`,
  {
    beforeMainMove: (h) => offerPolarity(h, 'before'),
    afterMainMove: (h) => offerPolarity(h, 'after'),
    resume: (h, key, choice) => {
      if (key !== 'polarity' || choice !== ('polarity' as ChoiceId)) return;
      const pulled = polarityTargets(h);
      if (pulled.length === 0) return;
      startTimer(h, 'polarity', POLARITY_COOLDOWN);
      h.log(`${h.nameOf(h.self)} reverses polarity: everyone near is pulled to space ${h.self.pos}.`);
      for (const r of pulled) h.warp(r, h.self.pos);
    },
  },
  5,
);

/** Asks Magnus whether to reverse polarity now, if it is ready and would pull anyone. */
function offerPolarity(h: HookCtx, when: 'before' | 'after'): void {
  if (!isRunning(h.self) || h.self.pos === FINISH || timerLeft(h.self, 'polarity') > 0) return;
  const pulled = polarityTargets(h);
  if (pulled.length === 0) return;
  h.ask({
    player: h.self.owner,
    prompt: `Reverse Polarity ${when} your move? It pulls ${pulled.map((r) => h.nameOf(r)).join(', ')} to space ${h.self.pos}. ${POLARITY_COOLDOWN}-turn cooldown.`,
    options: [
      option('polarity', `Pull ${pulled.length}`),
      option('wait', when === 'before' ? 'Not yet — ask after my move' : 'Save it'),
    ],
    key: 'polarity',
    defaultChoice: 'wait' as ChoiceId,
  });
}

/** Racers Reverse Polarity would pull: running, within 5, and not already with Magnus. */
function polarityTargets(h: HookCtx): MutableRacer[] {
  return h.running().filter((r) => r.racerId !== h.self.racerId && r.pos !== h.self.pos && near(h.self, r, 5));
}

/**
 * FIEND'S GATE — "I can skip my main move to warp to any other racer."
 *
 * Forwards or backwards, onto any space another running racer stands on. Offered before
 * the main move and not on a tripped turn, like every "skip my main move" power.
 */
const underlord = def('underlord', 'Underlord', "I can skip my main move to warp to any other racer's space.", {
  beforeMainMove: (h) => {
    if (!isRunning(h.self) || h.self.tripped) return;
    const spaces = [...new Set(h.running().map((r) => r.pos))]
      .filter((p) => p !== h.self.pos)
      .sort((a, b) => b - a);
    if (spaces.length === 0) return;
    h.ask({
      player: h.self.owner,
      prompt: "Fiend's Gate instead of rolling?",
      options: [
        ...spaces.map((p) =>
          option(
            `gate:${p}`,
            `To ${h
              .at(p)
              .filter(isRunning)
              .map((r) => h.nameOf(r))
              .join(', ')} (space ${p})`,
            { t: 'space', index: p },
          ),
        ),
        option('roll', 'Roll normally'),
      ],
      key: 'gate',
      defaultChoice: 'roll' as ChoiceId,
    });
  },
  resume: (h, key, choice) => {
    if (key !== 'gate' || choice === ('roll' as ChoiceId)) return;
    const pos = Number(String(choice).slice('gate:'.length));
    h.skipMainMove();
    h.log(`${h.nameOf(h.self)} steps through Fiend's Gate to space ${pos}.`);
    h.warp(h.self, pos);
  },
});

/**
 * DOOM — "Any racer on my space or next to it has no powers."
 *
 * No hooks: the aura is read off the board wherever powers are looked up. See `doomed` in
 * `characters/powers.ts`.
 */
const doom = def('doom', 'Doom', 'Other racers on my space or next to it have no powers, except on the Start space.', {}, 3);

/**
 * GOD'S STRENGTH — "I can activate my power to get +2 to my main move for 3 turns. 6-turn
 * cooldown."
 *
 * Activated before the main move, so the turn it's cast is the first of the three. The
 * three are my own turns, tripped ones included — a trip wastes one.
 */
const STRENGTH_BONUS = 2;
const STRENGTH_TURNS = 3;
const STRENGTH_COOLDOWN = 6;
const sven = def(
  'sven',
  'Sven',
  `Before my main move, I can get +${STRENGTH_BONUS} to my main move this turn and my next ${STRENGTH_TURNS - 1}. Ready again ${STRENGTH_COOLDOWN} turns later.`,
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped || timerLeft(h.self, 'strengthCooldown') > 0) return;
      h.ask({
        player: h.self.owner,
        prompt: `God's Strength? +${STRENGTH_BONUS} to your main move for ${STRENGTH_TURNS} turns. ${STRENGTH_COOLDOWN}-turn cooldown.`,
        options: [option('strength', "God's Strength"), option('wait', 'Not yet')],
        key: 'strength',
        defaultChoice: 'wait' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'strength' || choice !== ('strength' as ChoiceId)) return;
      startTimer(h, 'strength', STRENGTH_TURNS);
      startTimer(h, 'strengthCooldown', STRENGTH_COOLDOWN);
      h.log(`${h.nameOf(h.self)} roars: God's Strength!`);
    },
    modifyMainMove: (h, value, mover) => {
      if (mover.racerId !== h.self.racerId || timerLeft(h.self, 'strength') === 0) return value;
      h.log(`${h.nameOf(h.self)}'s God's Strength: +${STRENGTH_BONUS}.`);
      return value + STRENGTH_BONUS;
    },
  },
);

/**
 * SHODO SAI — "Before my main move, I can choose to roll an odd-only or an even-only d6."
 *
 * The odd die shows 1, 3 or 5, the even one 2, 4 or 6. The pick is for this turn's die,
 * rerolls included, and lapses at the turn's end; any other roll is a plain d6.
 */
const kez = def(
  'kez',
  'Kez',
  'Before my main move, I can roll an odd-only die (1, 3, 5) or an even-only die (2, 4, 6) instead of my d6.',
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped) return;
      h.ask({
        player: h.self.owner,
        prompt: 'Which die this turn?',
        options: [option('odd', 'Odd: 1, 3 or 5'), option('even', 'Even: 2, 4 or 6'), option('d6', 'A plain d6')],
        key: 'stance',
        defaultChoice: 'd6' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'stance' || (choice !== ('odd' as ChoiceId) && choice !== ('even' as ChoiceId))) return;
      startTimer(h, choice, 1);
      h.log(`${h.nameOf(h.self)} picks the ${choice} die.`);
    },
    throwDie: (h) => {
      const third = h.rng.roll(3);
      if (timerLeft(h.self, 'odd') > 0) return { face: third * 2 - 1, sides: 6, dice: [third * 2 - 1] };
      if (timerLeft(h.self, 'even') > 0) return { face: third * 2, sides: 6, dice: [third * 2] };
      const face = h.rng.roll(6);
      return { face, sides: 6, dice: [face] };
    },
  },
);

/**
 * INVOKE — "I can skip my main move to roll 3 dice that each land blue, pink or orange,
 * and cast one of 10 spells. Ready again 2 turns later."
 *
 * Three orbs, ten mixes, ten spells, as in Dota: blue is Quas, pink Wex, orange Exort. Only
 * a pink orb moves me, only an orange one trips anyone, and a blue one pushes back.
 *
 *  - Choosing Invoke is the throw: the orbs land straight away and the spell goes off.
 *  - Cast on turn T, it is ready again on turn T+2 — every other turn at most. Not
 *    offered on a tripped turn, which has no main move to skip.
 *  - A spell that moves me and then acts (Tornado, Chaos Meteor, Deafening Blast) acts from
 *    wherever that move settles — and not at all once I've crossed the finish line.
 *  - "Until my next turn" (Ghost Walk, Ice Wall) ends as that turn begins.
 *  - Ice Wall stops a racer that began its move behind the wall and would step past it.
 *    Forward moves only: going back over a racer is not passing them, nor is it passing a
 *    wall.
 *  - Forge Spirit guards the space it was summoned on, not wherever I go next: for the rest
 *    of that turn and my next 3.
 */
const INVOKE_COOLDOWN = 2;
const ORBS = ['blue', 'pink', 'orange'] as const;
type Orb = (typeof ORBS)[number];
/**
 * The spells, each by its orbs counted out as blues, then pinks, then oranges — the one
 * table both the casting and the reference card read.
 */
const SPELLS = [
  { orbs: 'bbb', name: 'Cold Snap', text: 'Push any racer back 6.' },
  { orbs: 'ppp', name: 'EMP', text: 'I move 6. Racers I pass lose their powers for 1 turn.' },
  { orbs: 'ooo', name: 'Sun Strike', text: 'Pick a space: every racer on it trips.' },
  { orbs: 'bbp', name: 'Ghost Walk', text: "I move 2, and can't be tripped until my next turn." },
  { orbs: 'bbo', name: 'Ice Wall', text: 'Until my next turn, racers who would pass my space stop there and trip.' },
  { orbs: 'bpp', name: 'Tornado', text: 'I move 4, then racers within 2 spaces of me go back 2.' },
  { orbs: 'ppo', name: 'Alacrity', text: 'I move 4, and get +2 to my next main move.' },
  { orbs: 'boo', name: 'Forge Spirit', text: 'For my next 3 turns, racers who stop on my space or next to it trip.' },
  { orbs: 'poo', name: 'Chaos Meteor', text: 'I move 2, then racers on the 3 spaces ahead of me trip.' },
  { orbs: 'bpo', name: 'Deafening Blast', text: 'I move 2, then racers on the 3 spaces ahead of me go back 2.' },
] as const;
type Spell = (typeof SPELLS)[number]['name'];
const ORB_OF = { b: 'blue', p: 'pink', o: 'orange' } as const;
/** Token kinds: the Ice Wall and the Forge Spirit stand on the board as tokens. */
const ICE_WALL = 'iceWall';
const FORGE_SPIRIT = 'forgeSpirit';
/** `memo` key: Alacrity waiting to be spent. */
const ALACRITY = 'alacrity';

const invokerDef = def(
  'invoker',
  'Invoker',
  `I can skip my main move to roll 3 dice that each land blue, pink or orange, and cast one of 10 spells. Ready again ${INVOKE_COOLDOWN} turns later.`,
  {
    beforeMainMove: (h) => {
      // "Until my next turn" is up.
      stopTimer(h, 'ghostWalk');
      for (const wall of ownTokens(h, ICE_WALL)) h.removeToken(wall.id);
      if (!isRunning(h.self) || h.self.tripped || timerLeft(h.self, 'invoke') > 0) return;
      h.ask({
        player: h.self.owner,
        prompt: `Invoke? Skip your roll to throw 3 orbs and cast the spell they make. Ready again ${INVOKE_COOLDOWN} turns later.`,
        options: [option('invoke', 'Invoke'), option('roll', 'Roll normally')],
        key: 'invoke',
        defaultChoice: 'roll' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key === 'invoke' && choice === ('invoke' as ChoiceId)) invoke(h);
      else if (key === 'coldSnap') {
        const victim = h.running().find((r) => choice === (`snap:${r.racerId}` as ChoiceId));
        if (victim) h.move(victim, -6);
      } else if (key === 'sunStrike') {
        const pos = Number(String(choice).slice('strike:'.length));
        for (const r of h.running().filter((r) => r.pos === pos)) h.trip(r);
      } else if (key === 'Tornado' || key === 'Chaos Meteor' || key === 'Deafening Blast') aftershock(h, key);
    },
    modifyMainMove: (h, value, mover) => {
      if (mover.racerId !== h.self.racerId || h.self.memo[ALACRITY] !== true) return value;
      delete h.self.memo[ALACRITY];
      h.log(`${h.nameOf(h.self)}'s Alacrity: +2.`);
      return value + 2;
    },
    ignoresTrip: (h) => {
      if (timerLeft(h.self, 'ghostWalk') === 0) return false;
      h.log(`${h.nameOf(h.self)} ghost walks through the trip.`);
      return true;
    },
    haltsMove: (h, mover, origin, from, to) => {
      const hit = ownTokens(h, ICE_WALL).some(({ pos }) => origin < pos && from <= pos && to > pos);
      if (!hit) return false;
      h.log(`${h.nameOf(mover)} runs into the Ice Wall!`);
      h.trip(mover);
      return true;
    },
    onOtherStops: (h, other) => {
      if (other.tripped || !h.running().some((r) => r.racerId === other.racerId)) return;
      if (!ownTokens(h, FORGE_SPIRIT).some(({ pos }) => Math.abs(other.pos - pos) <= 1)) return;
      h.log(`The Forge Spirit burns ${h.nameOf(other)}!`);
      h.trip(other);
    },
    onPass: (h, passed) => {
      if (timerLeft(h.self, 'emp') === 0) return;
      h.log(`${h.nameOf(h.self)}'s EMP drains ${h.nameOf(passed)}.`);
      h.silence(passed, 1);
    },
  },
);

const invoker: RacerDef = {
  ...invokerDef,
  reference: {
    intro: 'The colours of the 3 dice pick the spell, in any order.',
    entries: SPELLS.map(({ orbs, name, text }) => ({
      name,
      text,
      swatches: [...orbs].map((o) => ORB_OF[o as keyof typeof ORB_OF]),
    })),
  },
};

/** Throws Invoker's three orbs and casts the spell they make. */
function invoke(h: HookCtx): void {
  h.skipMainMove();
  startTimer(h, 'invoke', INVOKE_COOLDOWN);
  const faces = [0, 1, 2].map(() => h.rng.roll(3));
  const orbs = faces.map((f) => ORBS[f - 1]!);
  h.emit({
    t: 'dice/thrown',
    player: h.self.owner,
    racerId: h.self.racerId,
    value: 0,
    die: 3,
    dice: faces,
    colours: orbs,
    power: h.self.racerId,
  });
  const count = (orb: Orb): number => orbs.filter((o) => o === orb).length;
  const pink = count('pink');
  const key = 'b'.repeat(count('blue')) + 'p'.repeat(pink) + 'o'.repeat(count('orange'));
  const spell: Spell = SPELLS.find((s) => s.orbs === key)!.name;
  h.log(`${h.nameOf(h.self)} invokes ${spell}!`);

  switch (spell) {
    case 'Cold Snap': {
      // A racer on Start can't be pushed any further back.
      const targets = h.running().filter((r) => r.racerId !== h.self.racerId && r.pos > START);
      if (targets.length === 0) break;
      h.ask({
        player: h.self.owner,
        prompt: 'Cold Snap: push which racer back 6?',
        options: targets.map((r) => option(`snap:${r.racerId}`, h.nameOf(r), racerTarget(r.racerId))),
        key: 'coldSnap',
      });
      break;
    }
    case 'Sun Strike': {
      const spaces = [...new Set(h.running().filter((r) => !r.tripped).map((r) => r.pos))].sort((a, b) => a - b);
      if (spaces.length === 0) break;
      h.ask({
        player: h.self.owner,
        prompt: 'Sun Strike: every racer on the space you pick trips.',
        options: spaces.map((p) =>
          option(
            `strike:${p}`,
            `Space ${p}: ${h.running().filter((r) => r.pos === p).map((r) => h.nameOf(r)).join(', ')}`,
            { t: 'space', index: p },
          ),
        ),
        key: 'sunStrike',
      });
      break;
    }
    case 'EMP':
      startTimer(h, 'emp', 1);
      break;
    case 'Ghost Walk':
      startTimer(h, 'ghostWalk', 2);
      break;
    case 'Ice Wall':
      // Two turns at most, in case my next turn's `beforeMainMove` never comes (silenced).
      h.placeToken(ICE_WALL, 'Ice Wall', h.self.pos, 2);
      break;
    case 'Alacrity':
      h.self.memo[ALACRITY] = true;
      break;
    case 'Forge Spirit':
      h.placeToken(FORGE_SPIRIT, 'Forge Spirit', h.self.pos, 4);
      break;
    case 'Tornado':
    case 'Chaos Meteor':
    case 'Deafening Blast':
      // Deferred first, so it comes due once the move below has settled.
      h.defer(spell);
      break;
  }
  h.move(h.self, pink * 2);
}

/** The second half of a spell that moves Invoker first, from where that move settled. */
function aftershock(h: HookCtx, spell: 'Tornado' | 'Chaos Meteor' | 'Deafening Blast'): void {
  if (!h.running().some((r) => r.racerId === h.self.racerId)) return;
  const others = h.running().filter((r) => r.racerId !== h.self.racerId);
  const ahead = others.filter((r) => r.pos > h.self.pos && r.pos <= h.self.pos + 3);
  if (spell === 'Chaos Meteor') {
    for (const r of ahead) h.trip(r);
    return;
  }
  const pushed = spell === 'Tornado' ? others.filter((r) => near(h.self, r, 5) && r.pos > START) : ahead;
  // Moves are queued at the front, so queue in reverse to push in board order.
  for (const r of [...pushed].reverse()) h.move(r, -2);
}

/** `self`'s tokens of one kind on the board — a snapshot, so removing them as it goes is safe. */
function ownTokens(h: HookCtx, kind: string) {
  return h.tokens().filter((t) => t.owner === h.self.racerId && t.kind === kind);
}

/** Ends `self`'s timer `name` early. */
function stopTimer(h: HookCtx, name: string): void {
  const timers = { ...((h.self.memo[TIMERS] ?? {}) as Record<string, number>) };
  delete timers[name];
  h.self.memo[TIMERS] = timers;
}

/**
 * CROAK OF GENIUS — "My main move gets +1 for each racer on my space, me included. Every
 * other racer on my space gets +1 to their main move."
 *
 * The band plays together: counted as each main move is settled, from where the mover
 * stands then. Teammates, tripped racers and rivals all count. Start is no exception, so
 * Largo opens the race to a full house.
 */
const largo = def(
  'largo',
  'Largo',
  'I get +1 to my main move for each racer on my space, me included. Other racers on my space get +1 to theirs.',
  {
    modifyMainMove: (h, value, mover) => {
      if (!isRunning(h.self)) return value;
      if (mover.racerId === h.self.racerId) {
        const band = 1 + h.sharing().filter(isRunning).length;
        h.log(`${h.nameOf(h.self)} croaks for a band of ${band}: +${band}.`);
        return value + band;
      }
      if (mover.pos !== h.self.pos) return value;
      h.log(`${h.nameOf(h.self)}'s song carries ${h.nameOf(mover)}: +1.`);
      return value + 1;
    },
  },
);

/**
 * OMNISLASH — "I can skip my main move to warp onto a racer 1 or 2 spaces ahead of me,
 * the nearer one if both. Then I must keep hopping the same way until no racer is 1 or 2
 * spaces ahead. Only the space I finish on takes effect. Ready again 4 turns later."
 *
 * The choice is only whether to start: the chain then runs itself, always to the nearer
 * racer, so it takes every hop it can. Each hop is its own happening — Scoocher scooches
 * once per slash. The hops are one warp to the end of the chain, so the spaces in between
 * never fire and nobody is passed. Racers across the finish line are out of reach, so the
 * chain never carries Juggernaut over it.
 */
const OMNISLASH_COOLDOWN = 4;
const juggernaut = def(
  'juggernaut',
  'Juggernaut',
  `I can skip my main move to warp onto a racer 1 or 2 spaces ahead of me, the nearer one if both. Then I must keep hopping the same way until no racer is 1 or 2 spaces ahead. Only the space I finish on takes effect. Ready again ${OMNISLASH_COOLDOWN} turns later.`,
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped || timerLeft(h.self, 'omnislash') > 0) return;
      const hops = omnislashPath(h);
      if (hops.length === 0) return;
      const end = hops[hops.length - 1]!;
      h.ask({
        player: h.self.owner,
        prompt: `Omnislash instead of rolling? ${hops.length} hop${hops.length === 1 ? '' : 's'}, ending on space ${end}. Ready again ${OMNISLASH_COOLDOWN} turns later.`,
        options: [option('slash', `Omnislash to space ${end}`, { t: 'space', index: end }), option('roll', 'Roll normally')],
        key: 'omnislash',
        defaultChoice: 'roll' as ChoiceId,
      });
    },
    resume: (h, key, choice) => {
      if (key !== 'omnislash' || choice !== ('slash' as ChoiceId)) return;
      const hops = omnislashPath(h);
      h.skipMainMove();
      startTimer(h, 'omnislash', OMNISLASH_COOLDOWN);
      if (hops.length === 0) return;
      hops.forEach((pos, i) =>
        h.log(`${h.nameOf(h.self)} Omnislashes to space ${pos}${i === hops.length - 1 ? ', and stops.' : '…'}`),
      );
      h.warp(h.self, hops[hops.length - 1]!);
    },
  },
);

/** Juggernaut's chain from where it stands: each hop to the nearest racer 1 or 2 ahead. */
function omnislashPath(h: HookCtx): number[] {
  const spaces = new Set(h.running().filter((r) => r.racerId !== h.self.racerId).map((r) => r.pos));
  const hops: number[] = [];
  let at = h.self.pos;
  for (; ;) {
    const next = [at + 1, at + 2].find((p) => spaces.has(p));
    if (next === undefined) return hops;
    hops.push(next);
    at = next;
  }
}

/**
 * FIERY SOUL — "Every turn I gain a stack of Fiery Soul, up to 6. I get +1 to my main move
 * for every 2 stacks. Tripping resets them."
 *
 * The stack comes before the main move, so it counts on the turn it's gained: +1 from the
 * second turn, +3 from the sixth. A tripped turn gains nothing — the trip has just burned
 * them all — and neither does a silenced one.
 */
const FIERY_SOUL_MAX = 6;
const lina = def(
  'lina',
  'Lina',
  `Each turn I'm not tripped, I gain a Fiery Soul stack, up to ${FIERY_SOUL_MAX}. I get +1 to my main move for every 2 stacks. Tripping clears them.`,
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || h.self.tripped) return;
      h.self.memo['fierySoul'] = Math.min(FIERY_SOUL_MAX, fierySoul(h.self) + 1);
    },
    modifyMainMove: (h, value, mover) => {
      if (mover.racerId !== h.self.racerId) return value;
      const bonus = Math.floor(fierySoul(h.self) / 2);
      if (bonus === 0) return value;
      h.log(`${h.nameOf(h.self)}'s Fiery Soul burns at ${fierySoul(h.self)} stacks: +${bonus}.`);
      return value + bonus;
    },
    onRacerTripped: (h, target) => {
      if (target.racerId !== h.self.racerId || !h.self.tripped || fierySoul(h.self) === 0) return;
      delete h.self.memo['fierySoul'];
      h.log(`${h.nameOf(h.self)} goes down and her Fiery Soul gutters out.`);
    },
  },
);

/** Lina's Fiery Soul stacks. */
function fierySoul(racer: MutableRacer): number {
  const stacks = racer.memo['fierySoul'];
  return typeof stacks === 'number' ? stacks : 0;
}

/**
 * COUP DE GRACE — "I roll two d6s and move the first. If the second is a 6, I move triple
 * the first instead."
 *
 * The pair is my main move's die, rerolls included, and the face a power reads from it. A
 * roll a power asks for, like a bash, is one plain d6. A crit is one in six, worth 3 to 18.
 */
const phantomAssassin = def(
  'phantom-assassin',
  'Phantom Assassin',
  'I roll two d6s and move the first. If the second is a 6, I move triple the first instead.',
  {
    throwDie: (h) => {
      const a = h.rng.roll(6);
      const b = h.rng.roll(6);
      const face = b === 6 ? a * 3 : a;
      if (b === 6) h.log(`${h.nameOf(h.self)} lands a Coup de Grace: ${a} × 3 = ${face}!`);
      return { face, sides: 6, dice: [a, b] };
    },
  },
);

/**
 * WALRUS PUNCH — "Before my main move, and again after it, I can punch a racer on my space
 * to trip them."
 *
 * One racer a punch, anyone on my space still standing, teammates included. The first
 * punch isn't offered on a tripped turn — Tusk is on the floor too — and the second only
 * after a main move that went somewhere, like every "after my main move" power.
 */
const tusk = def(
  'tusk',
  'Tusk',
  'Before my main move, and again after it, I can punch a racer on my space to trip them.',
  {
    beforeMainMove: (h) => {
      if (!h.self.tripped) offerPunch(h);
    },
    afterMainMove: (h) => offerPunch(h),
    resume: (h, key, choice) => {
      if (key !== 'punch' || choice === ('pass' as ChoiceId)) return;
      const victim = punchable(h).find((r) => choice === (`punch:${r.racerId}` as ChoiceId));
      if (!victim) return;
      h.log(`${h.nameOf(h.self)} winds up a Walrus Punch on ${h.nameOf(victim)}!`);
      h.trip(victim);
    },
  },
);

/** Asks Tusk whether to punch, if anyone on its space is still standing. */
function offerPunch(h: HookCtx) {
  if (!isRunning(h.self)) return;
  const targets = punchable(h);
  if (targets.length === 0) return;
  h.ask({
    player: h.self.owner,
    prompt: 'Walrus Punch a racer on your space?',
    options: [
      ...targets.map((r) => option(`punch:${r.racerId}`, `Punch ${h.nameOf(r)}`, racerTarget(r.racerId))),
      option('pass', 'Not now'),
    ],
    key: 'punch',
    defaultChoice: 'pass' as ChoiceId,
  });
}

/** Tusk's targets: running racers on its space still on their feet. */
function punchable(h: HookCtx) {
  return h.sharing().filter((r) => isRunning(r) && !r.tripped);
}

/**
 * SOULBIND — "Before my main move, I can bind two racers within 5 spaces of each other.
 * Until my next turn, neither can get more than 5 spaces from the other. If the link would
 * have to hold them back forever, it snaps. Ready again 4 turns later."
 *
 * Any two running racers, Grimstroke among them. The engine keeps the leash (see `SOULBIND`
 * and `leashesOf`): a move that would step out of reach stops short, and a warp lands on
 * the nearest space still in reach. Only a step that widens the gap is held, so a pair
 * that ends up too far apart some other way can still come back together. A link that has
 * to hold its racers back again and again is stuck refusing a power that keeps trying — a
 * loop — so after `LEASH_SNAP` holds it snaps rather than hang the game. Crossing the
 * finish line frees both racers, and Grimstroke's next turn ends the link, tripped or
 * silenced.
 *
 * Cast on a tripped turn too: it's a spell, not a move.
 */
const SOULBIND_COOLDOWN = 4;
const grimstroke = def(
  'grimstroke',
  'Grimstroke',
  `Before my main move, I can bind two racers within ${LEASH} spaces of each other, me included. Until my next turn, neither can get more than ${LEASH} spaces from the other. If the link would have to hold them back forever, it snaps. Ready again ${SOULBIND_COOLDOWN} turns later.`,
  {
    beforeMainMove: (h) => {
      if (!isRunning(h.self) || timerLeft(h.self, 'soulbind') > 0) return;
      const firsts = h.running().filter((r) => bindable(h, r).length > 0);
      if (firsts.length === 0) return;
      h.ask({
        player: h.self.owner,
        prompt: `Soulbind two racers within ${LEASH} spaces of each other? Pick the first. ${SOULBIND_COOLDOWN}-turn cooldown.`,
        options: [
          ...firsts.map((r) => option(`bind:${r.racerId}`, h.nameOf(r), racerTarget(r.racerId))),
          option('pass', 'Not now'),
        ],
        key: 'soulbind',
        defaultChoice: 'pass' as ChoiceId,
      });
    },
    resume: (h, key, choice, data) => {
      if (choice === ('pass' as ChoiceId)) return;
      if (key === 'soulbind') {
        const first = h.running().find((r) => choice === (`bind:${r.racerId}` as ChoiceId));
        if (!first) return;
        const partners = bindable(h, first);
        if (partners.length === 0) return;
        h.ask({
          player: h.self.owner,
          prompt: `Soulbind ${h.nameOf(first)} to whom?`,
          options: [
            ...partners.map((r) => option(`with:${r.racerId}`, h.nameOf(r), racerTarget(r.racerId))),
            option('pass', 'Never mind'),
          ],
          key: 'soulbindWith',
          data: { first: first.racerId },
          defaultChoice: 'pass' as ChoiceId,
        });
        return;
      }
      if (key !== 'soulbindWith') return;
      const first = h.running().find((r) => r.racerId === (data as { first: string }).first);
      if (!first) return;
      const second = bindable(h, first).find((r) => choice === (`with:${r.racerId}` as ChoiceId));
      if (!second) return;
      const link: Soulbind = { a: first.racerId, b: second.racerId, holds: 0 };
      h.self.memo[SOULBIND] = link;
      startTimer(h, 'soulbind', SOULBIND_COOLDOWN);
      h.log(
        `${h.nameOf(h.self)} Soulbinds ${h.nameOf(first)} and ${h.nameOf(second)}: neither can stray more than ${LEASH} from the other.`,
      );
    },
  },
);

/**
 * MAGNETIC FIELD — "I roll two d6s and move whichever one I choose."
 *
 * The pair is thrown for my main move, rerolls included, and I say which face counts before
 * anyone reacts to it; the other is discarded. If both show the same there is nothing to
 * choose, and when the clock runs out the higher one counts. A roll a power asks for, like a
 * duel or a bash, is one plain d6.
 */
const ARC_DICE = 'arcDice';
const arcWarden = def('arc-warden', 'Arc Warden', 'I roll two d6s and move whichever one I choose.', {
  throwDie: (h) => {
    const a = h.rng.roll(6);
    const b = h.rng.roll(6);
    h.self.memo[ARC_DICE] = [a, b];
    return { face: Math.max(a, b), sides: 6, dice: [a, b] };
  },
  onMainRoll: (h, mover) => {
    if (mover.racerId !== h.self.racerId || !isRunning(h.self)) return;
    // Used up here, so a throw made without the power — silenced, or before Morphling
    // took it on — never offers the dice of some earlier throw.
    const [a, b] = (h.self.memo[ARC_DICE] ?? []) as number[];
    delete h.self.memo[ARC_DICE];
    if (a === undefined || b === undefined || a === b) return;
    if (h.mainRoll()?.value !== Math.max(a, b)) return;
    const [low, high] = a < b ? [a, b] : [b, a];
    h.ask({
      player: h.self.owner,
      prompt: `Move ${high} or ${low}?`,
      options: [option(String(high), `Move ${high}`), option(String(low), `Move ${low}`)],
      key: 'pick',
      data: [low, high],
      defaultChoice: String(high) as ChoiceId,
    });
  },
  resume: (h, key, choice, data) => {
    if (key !== 'pick') return;
    const face = Number(choice);
    if (!(data as number[]).includes(face)) return;
    h.chooseMainRoll(face);
    h.log(`${h.nameOf(h.self)} takes the ${face}.`);
  },
});

/**
 * DIVIDED WE STAND — "I race as 4 Meepos. On my turn, each Meepo rolls its own die and moves
 * on its own. I finish as soon as any one Meepo crosses the finish line."
 *
 * No hooks: the engine builds it. Committing Meepo puts four pieces on the board (see
 * `squad`), each a racer in its own right — passed, counted, tripped and targeted one at a
 * time, so only the Meepo that is hit goes down. They are all the owner's racers, so each
 * takes its own go every turn, the opening turn included, in the order the owner picks.
 * When one is placed the other three leave the board: Meepo takes one place at most.
 */
const MEEPO_TEXT = 'I race as 4 Meepos. On my turn, each Meepo rolls its own die and moves on its own. I finish as soon as any one Meepo crosses the finish line.';
const MEEPO_PIECES = ['meepo-2', 'meepo-3', 'meepo-4'] as const;
const meepo: RacerDef = { ...def('meepo', 'Meepo', MEEPO_TEXT, {}), squad: MEEPO_PIECES.map((id) => racerId(id)) };
const meepoPieces: RacerDef[] = MEEPO_PIECES.map((id, i) => ({
  ...def(id, `Meepo ${i + 2}`, MEEPO_TEXT, {}),
  pieceOf: racerId('meepo'),
}));

/** Who `first` can be Soulbound to: other running racers within `LEASH` of it. */
function bindable(h: HookCtx, first: MutableRacer) {
  return h.running().filter((r) => r.racerId !== first.racerId && Math.abs(r.pos - first.pos) <= LEASH);
}

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
  bloodseeker,
  clockwerk,
  pudge,
  techies,
  chaosKnight,
  abaddon,
  emberSpirit,
  earthSpirit,
  bristleback,
  drowRanger,
  nightStalker,
  slark,
  voidSpirit,
  lich,
  magnus,
  underlord,
  doom,
  sven,
  kez,
  invoker,
  largo,
  juggernaut,
  lina,
  phantomAssassin,
  tusk,
  grimstroke,
  arcWarden,
  meepo,
  ...meepoPieces,
];
