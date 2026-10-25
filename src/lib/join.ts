import { checkJoinLink } from '../core/links';
import { openExternal } from './platform';
import { useStore } from '../state/store';

/** Open a class link: allow-listed https links open at once; anything else asks first, showing its real domain. */
export function openJoin(url: string) {
  const st = useStore.getState();
  const check = checkJoinLink(url, st.doc.settings);
  if (check?.ok) openExternal(url);
  else st.open({ joinWarn: { url, domain: check?.domain ?? url } });
}
