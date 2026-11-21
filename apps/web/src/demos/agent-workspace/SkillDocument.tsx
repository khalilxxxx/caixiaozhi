import { MessageText } from './MessageText';
import {
  skillDocumentText,
  type Skill,
  type SkillVersion,
} from './skills-catalog-model';
import './skill-document.css';

export function SkillDocument({
  skill,
  version,
}: {
  skill: Skill;
  version: SkillVersion;
}) {
  const source = skillDocumentText(skill, version);
  if (!source)
    return <p className="skill-doc-empty">此版本暂无可展示的技能正文。</p>;

  const text = source.replace(/\r\n?/g, '\n');
  const fields =
    !version.file &&
    text
      .trim()
      .match(
        /^输入[：:][ \t]*([^\n]+)\n输出[：:][ \t]*([^\n]+)(?:\n([\s\S]*))?$/,
      );

  if (fields) {
    const [, input, output, requirements] = fields;
    return (
      <section className="skill-doc" aria-label="技能正文">
        <dl className="skill-doc-fields">
          <div>
            <dt>输入</dt>
            <dd>{input}</dd>
          </div>
          <div>
            <dt>输出</dt>
            <dd>{output}</dd>
          </div>
        </dl>
        {requirements?.trim() && (
          <div className="skill-doc-requirements">
            <h3>执行要求</h3>
            <MessageText
              text={requirements}
              tableLabel="技能正文中的表格"
              className="skill-doc-text"
            />
          </div>
        )}
      </section>
    );
  }

  const title = text.match(/^\s*#\s+([^\n]+)\n+/);
  const body =
    title?.[1]?.trim() === skill.title.trim() &&
    text.slice(title[0].length).trim()
      ? text.slice(title[0].length)
      : text;
  return (
    <section className="skill-doc" aria-label="技能正文">
      <MessageText
        text={body}
        tableLabel="技能正文中的表格"
        className="skill-doc-text"
      />
    </section>
  );
}
