import { describe, expect, it } from 'vitest';
import {
  ashbyLabels, isEeocQuestion, matchAnswers, normalizeQuestion,
  type AnswerRow, type AshbyFormSection,
} from '../src/kit/questions';

describe('normalizeQuestion', () => {
  it('lowercases, strips accents/punctuation, collapses spaces', () => {
    expect(normalizeQuestion('  Are you AUTHORIZED to work in Canada?! ')).toBe('are you authorized to work in canada');
    expect(normalizeQuestion('¿Años de experiencia?')).toBe('anos de experiencia');
  });
});

describe('isEeocQuestion (never auto-answered)', () => {
  it('flags demographic/EEOC questions', () => {
    expect(isEeocQuestion('What is your gender?')).toBe(true);
    expect(isEeocQuestion('Race/Ethnicity (voluntary)')).toBe(true);
    expect(isEeocQuestion('Are you a protected veteran?')).toBe(true);
    expect(isEeocQuestion('Do you identify as having a disability?')).toBe(true);
  });
  it('does not flag regular questions', () => {
    expect(isEeocQuestion('Years of SQL experience?')).toBe(false);
    expect(isEeocQuestion('Are you authorized to work in Canada?')).toBe(false);
  });
});

describe('ashbyLabels (Ashby form → real screening questions)', () => {
  // Mirrors the live KOHO payload verified 2026-07-20.
  const sections: AshbyFormSection[] = [{
    fieldEntries: [
      { field: { path: '_systemfield_name', title: 'Name', type: 'String' } },
      { field: { path: '_systemfield_email', title: 'Email', type: 'Email' } },
      { field: { path: '_systemfield_resume', title: 'Resume', type: 'File' } },
      { field: { path: 'e28996', title: 'Why do you want to work at KOHO?', type: 'LongText' } },
      { field: { path: '8e56f9', title: 'Are you legally eligible to work in Canada?', type: 'Boolean' } },
      { field: { path: 'old', title: 'Deprecated question', type: 'String', isDeactivated: true } },
      { field: { path: 'dup', title: 'Why do you want to work at KOHO?', type: 'LongText' } },
    ],
  }];

  it('keeps custom questions in order; drops system autofill, deactivated, and dups', () => {
    expect(ashbyLabels(sections)).toEqual([
      'Why do you want to work at KOHO?',
      'Are you legally eligible to work in Canada?',
    ]);
  });

  it('falls back to humanReadablePath when title is blank', () => {
    const s: AshbyFormSection[] = [{ fieldEntries: [
      { field: { path: 'p', title: '', humanReadablePath: 'What province are you in?', type: 'ValueSelect' } },
    ] }];
    expect(ashbyLabels(s)).toEqual(['What province are you in?']);
  });

  it('tolerates empty/missing sections', () => {
    expect(ashbyLabels([])).toEqual([]);
    expect(ashbyLabels([{}])).toEqual([]);
  });
});

describe('matchAnswers', () => {
  const bank: AnswerRow[] = [
    { id: 1, question_norm: 'are you authorized to work in canada', question_label: 'Work auth CA', answer_en: 'Yes — valid co-op work permit.' },
    { id: 2, question_norm: 'notice period', question_label: 'Notice', answer_en: 'Two weeks.' },
  ];

  it('matches exact normalized questions', () => {
    const m = matchAnswers(['Are you authorized to work in Canada?'], bank);
    expect(m[0]!.red).toBe(false);
    expect(m[0]!.answer).toContain('co-op');
    expect(m[0]!.source).toBe('bank');
  });

  it('matches by containment when long enough', () => {
    const m = matchAnswers(['What is your notice period at your current employer?'], bank);
    expect(m[0]!.red).toBe(false);
    expect(m[0]!.answer).toBe('Two weeks.');
  });

  it('leaves unknown questions red (no guessing)', () => {
    const m = matchAnswers(['Why do you want to work here?'], bank);
    expect(m[0]!.red).toBe(true);
    expect(m[0]!.answer).toBeNull();
  });

  it('does not containment-match short strings (false-positive guard)', () => {
    const shortBank: AnswerRow[] = [{ id: 3, question_norm: 'salary', question_label: 'Salary', answer_en: 'Market.' }];
    const m = matchAnswers(['Sal'], shortBank);
    expect(m[0]!.red).toBe(true);
  });
});
