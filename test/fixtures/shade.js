// Shade dumps in the layout `dumpsys notification --noredact` prints on Android 15 (API 35, emulator):
// one NotificationRecord header line carrying pkg= and key=…: , extras indented below, the archive after.
export const record = ({ pkg, id, uid = 10171, title, text, big = '', updatedMs = 1792738727601 }) => `    NotificationRecord(0x0${id}: pkg=${pkg} user=UserHandle{0} id=${id} tag=null importance=4 key=0|${pkg}|${id}|null|${uid}: Notification(channel=msg shortcut=null contentView=null vibrate=null sound=null defaults=0 flags=AUTO_CANCEL color=0x00000000 vis=PRIVATE))
      uid=${uid} opPkg=${pkg}
      icon=Icon(typ=RESOURCE pkg=${pkg} id=0x7f080001)
      key=0|${pkg}|${id}|null|${uid}
      extras={
        android.title=String (${title})
${text ? `        android.text=String (${text})\n` : ''}${big ? `        android.bigText=String (${big})\n` : ''}        android.showWhen=Boolean (true)
      }
      mRankingTimeMs=${updatedMs}
      mCreationTimeMs=${updatedMs}
      mUpdateTimeMs=${updatedMs}
`;
export const shade = (records, archived = []) => `Notification Manager state:
  Notification List:
${records.join('')}  mArchive=Archive (${archived.length} notifications)
${archived.join('')}  mSnoozedNotifications:
`;
export const SYSTEM = record({ pkg: 'android', id: 19, uid: 1000, title: 'qwerty2 configured', text: 'Keyboard layout set to English (US). Tap to change.' });
export const QQ_KUAN = (text) => record({ pkg: 'com.tencent.mobileqq', id: 1, title: '宽', text });
export const QQ_GROUP = record({ pkg: 'com.tencent.mobileqq', id: 3, title: '群聊', text: '', big: '有人@你' });
