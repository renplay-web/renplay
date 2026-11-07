import { useState } from 'react'
import { Link } from 'react-router-dom'
import { adultLabels, adultLevels, lowestLevel, useAdultState, useDeviceLevel, useSetAdultChoice, type AdultLevel } from '../lib/adult'
import { Seg, SourceLabel, TagPill } from '../lantern/controls'
import { errorText, Spinner, useToast } from './ui'

/**
 * Three pills, Off, Blurred and Shown. A pill above `max` (the row above) is
 * struck through and cannot be chosen. Without `onChange` the row is fixed.
 */
export function LevelSeg({ label, value, max = 'shown', onChange, busy }: { label: string; value: AdultLevel; max?: AdultLevel; onChange?: (level: AdultLevel) => void; busy?: boolean }) {
  return (
    <Seg
      small
      label={label}
      value={value}
      onChange={onChange}
      disabled={busy}
      options={adultLevels.map((level) => ({
        value: level,
        label: adultLabels[level],
        na: adultLevels.indexOf(level) > adultLevels.indexOf(max),
        disabled: !onChange || adultLevels.indexOf(level) > adultLevels.indexOf(max),
      }))}
    />
  )
}

function LadderRow({ title, sub, source, fixed, children }: { title: string; sub?: string; source?: React.ReactNode; fixed?: boolean; children: React.ReactNode }) {
  return (
    // `locked`, not `fixed`: Tailwind's fixed is position: fixed.
    <div className={`lrow ${fixed ? 'locked' : ''}`.trim()}>
      <div className="l">
        <div className="t">{title}</div>
        {sub && <div className="d">{sub}</div>}
        {source}
      </div>
      {children}
    </div>
  )
}

/** What the person sees and which layer decides it, in one sentence. */
function summary(levels: AdultLevel[], group: boolean): string {
  const effective = lowestLevel(...levels)
  if (effective === 'shown') return 'You see adult games and their pictures.'
  const at = levels.indexOf(effective)
  const label = adultLabels[effective]
  const reason = [
    `this installation is set to ${label}`,
    group ? `your sign-in group allows at most ${label}` : `your account allows at most ${label}`,
    `you chose ${label}`,
    `you chose ${label} on this device`,
  ][at]
  return effective === 'blurred' ? `You see adult games with their pictures blurred, because ${reason}.` : `Adult games are hidden, because ${reason}.`
}

const installationSource = (s: { fixed: boolean; chosen: boolean }, variable = 'RENPLAY_ADULT'): React.ReactNode =>
  s.fixed ? <SourceLabel kind="server" label={variable} /> : s.chosen ? <SourceLabel kind="admin" /> : <SourceLabel kind="def" />

/** The account page's ladder: installation, account, you and this device. Each row can only narrow the one above. */
export default function AdultLadder() {
  const { data: state, error } = useAdultState()
  const [device, setDevice] = useDeviceLevel()
  const setChoice = useSetAdultChoice()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (error) return <p className="red small">{errorText(error)}</p>
  if (!state) return <Spinner />
  const installation = state.installation.level
  const ceiling = state.ceiling.level
  const yours = lowestLevel(installation, ceiling)
  const here = lowestLevel(yours, state.choice)
  const effective = lowestLevel(here, device ?? 'shown')
  const choose = async (level: AdultLevel) => {
    setBusy(true)
    try {
      await setChoice(level)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ladder">
      <LadderRow title="This installation" sub="The server allows up to this." source={installationSource(state.installation)} fixed>
        <LevelSeg label="This installation" value={installation} />
      </LadderRow>
      <LadderRow
        title="Your account"
        sub={state.ceiling.managed === 'group' ? 'A sign-in group sets your ceiling.' : 'Set by an admin for you. A configured sign-in group would replace it.'}
        source={state.ceiling.managed === 'group' ? <SourceLabel kind="group" /> : <SourceLabel kind="admin-you" />}
        fixed
      >
        <LevelSeg label="Your account" value={ceiling} max={installation} />
      </LadderRow>
      <LadderRow title="You" sub="Your choice, on every device." source={<SourceLabel kind="you" />}>
        <LevelSeg label="You" value={state.choice} max={yours} onChange={(level) => void choose(level)} busy={busy} />
      </LadderRow>
      <LadderRow title="This device" sub="Lower it here on a shared screen. Stays in this browser." source={<SourceLabel kind="def" />}>
        <LevelSeg label="This device" value={device ? lowestLevel(here, device) : here} max={here} onChange={(level) => setDevice(level === here ? null : level)} />
      </LadderRow>
      <div className="leff">
        <TagPill tone={effective === 'shown' ? 'pink' : effective === 'blurred' ? 'vio' : undefined}>{adultLabels[effective]}</TagPill>
        <span className="small muted-2">{summary([installation, ceiling, state.choice, device ?? 'shown'], state.ceiling.managed === 'group')}</span>
      </div>
    </div>
  )
}

/** Settings, This device: only the device row. The other levels live on the account page. */
export function DeviceAdultRow() {
  const { data: state } = useAdultState()
  const [device, setDevice] = useDeviceLevel()
  if (!state) return null
  const here = state.effective
  return (
    <div className="ladder">
      <LadderRow title="Adult games on this device" sub="Lower it here on a shared screen, never higher. The same control is on your account page, under Adult games." source={<SourceLabel kind="def" />}>
        <LevelSeg label="Adult games on this device" value={device ? lowestLevel(here, device) : here} max={here} onChange={(level) => setDevice(level === here ? null : level)} />
      </LadderRow>
      <p className="hint">
        This browser can show less than your account, never more. All levels are on your <Link to="/account" className="link">account page</Link>.
      </p>
    </div>
  )
}
