import { describe, expect, it } from 'vitest';
import { groupPhotosBySong, knownTitleFor, titleFromFileName } from '../../src/wednesday/photoTitles';
import { dropIndex, moveSongTo } from '../../src/wednesday/songOrder';

describe('a song title from a photo\'s file name', () => {
  it('reads the title a person gave the file', () => {
    expect(titleFromFileName('주님의 선하심.jpg')).toBe('주님의 선하심');
    expect(titleFromFileName('주님의_선하심_악보.png')).toBe('주님의 선하심');
    expect(titleFromFileName('은혜 (G키).jpeg')).toBe('은혜');
    expect(titleFromFileName('나의 반석이신 하나님 (1).jpg')).toBe('나의 반석이신 하나님');
  });

  it('takes nothing from a name a phone or a messenger made up', () => {
    expect(titleFromFileName('IMG_1234.JPG')).toBeUndefined();
    expect(titleFromFileName('KakaoTalk_20261005_123456789.jpg')).toBeUndefined();
    expect(titleFromFileName('KakaoTalk_Photo_2026-10-05-12-00-01 002.jpeg')).toBeUndefined();
    expect(titleFromFileName('스크린샷 2026-10-05 오후 3.12.45.png')).toBeUndefined();
    expect(titleFromFileName('1.jpg')).toBeUndefined();
    expect(titleFromFileName('악보 1.jpg')).toBeUndefined();
    expect(titleFromFileName('score.png')).toBeUndefined();
  });
});

describe('the title a reading stands for', () => {
  const known = ['주님의 선하심', '나의 반석이신 하나님', '은혜'];

  it('takes the known spelling of the same title', () => {
    expect(knownTitleFor('주님의선하심', known)).toBe('주님의 선하심');
    // One syllable misread.
    expect(knownTitleFor('주님의 선하싱', known)).toBe('주님의 선하심');
    expect(knownTitleFor('나의 반석이신 하나님 (Live)', known)).toBe('나의 반석이신 하나님');
  });

  it('keeps a reading that is no known title as it was read', () => {
    expect(knownTitleFor('주님의 은혜', known)).toBe('주님의 은혜');
    expect(knownTitleFor('완전히 새로운 곡', [])).toBe('완전히 새로운 곡');
  });
});

describe('which photos are one song', () => {
  it('puts the pages of one 악보 together, in a row', () => {
    expect(groupPhotosBySong(['은혜', '은혜', '주님의 선하심'])).toEqual([[0, 1], [2]]);
  });

  it('keeps every other photo a song of its own', () => {
    expect(groupPhotosBySong(['은혜', '주님의 선하심', '나의 반석이신 하나님'])).toEqual([[0], [1], [2]]);
    // An unread title may be the next song's first page: not joined.
    expect(groupPhotosBySong(['은혜', undefined, undefined])).toEqual([[0], [1], [2]]);
    // The same song twice, apart, is sung twice.
    expect(groupPhotosBySong(['은혜', '주님의 선하심', '은혜'])).toEqual([[0], [1], [2]]);
  });
});

describe('dragging a song card', () => {
  const songs = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

  it('moves a song to where it is dropped', () => {
    expect(moveSongTo(songs, 'a', 2).map((song) => song.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveSongTo(songs, 'd', 0).map((song) => song.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveSongTo(songs, 'b', 1).map((song) => song.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(moveSongTo(songs, 'b', 99).map((song) => song.id)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveSongTo(songs, 'z', 0).map((song) => song.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lands after every card whose middle it has passed', () => {
    const middles = [100, 300, 500, 700];
    expect(dropIndex(middles, 0, 100)).toBe(0);
    expect(dropIndex(middles, 0, 320)).toBe(1);
    expect(dropIndex(middles, 0, 900)).toBe(3);
    expect(dropIndex(middles, 3, 450)).toBe(2);
    expect(dropIndex(middles, 3, 0)).toBe(0);
  });
});
