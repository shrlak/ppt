// Only FreeCast content is reset. Accounts, Worker settings, shared libraries and remote links stay.
export function emptyFreecastLibrary(previous, resetId) {
  const themes = Array.isArray(previous?.themes) && previous.themes.length ? previous.themes : [{
    id: 'theme_classic', name: 'Classic', fontFamily: 'Arial', fontSize: 96, fontWeight: 700,
    color: '#ffffff', align: 'center', vAlign: 'middle', lineHeight: 1.2, padding: 120, shadow: false, uppercase: false,
  }];
  return { version: 1, aspect: '4:3', transitionsReset: true, backgroundLibraryReset: true, cloudResetId: resetId,
    presentations: [], playlists: [{ id: 'cloud-empty', name: '재생목록', items: [] }], themes,
    media: [], trash: [], protectionChanges: [], devices: [], activity: [], usage: [],
    timers: [], props: [], messageTemplates: [], macros: [], screens: [], schedules: [], looks: [], stageLayouts: [], logoMediaId: null,
    sunday: { ...(previous?.sunday ?? {}), frontId: null, prayerId: null, backId: null, prayerText: '', confessionSong: '' } };
}
