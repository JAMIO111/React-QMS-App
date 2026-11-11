import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { assignments, iso, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AllQuery, Category, CreateCategoryBody, CreatePositionBody, CreateSkillBody, Position, PositionSkill, ReasonBody, SetPositionSkillsBody, Skill, SkillListQuery, UpdateCategoryBody,
  UpdatePositionBody, UpdateSkillBody,
} from './competence.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const CATEGORY_COLUMNS: Record<string, string> = { label: 'label', description: 'description', sequence: 'sequence', active: 'active' };

const toCategory = (r: Row): Category => ({
  id: r.id as string,
  key: r.key as string,
  label: r.label as string,
  description: (r.description as string) ?? null,
  sequence: Number(r.sequence),
  active: !!r.active,
  skills: Number(r.skill_count ?? 0),
});

const toSkill = (r: Row): Skill => ({
  id: r.id as string,
  code: r.code as string,
  name: r.name as string,
  category: { id: r.category_id as string, label: r.category_label as string },
  description: (r.description as string) ?? null,
  refreshMonths: r.refresh_months === null || r.refresh_months === undefined ? null : Number(r.refresh_months),
  active: !!r.active,
  retiredReason: (r.retired_reason as string) ?? null,
  retiredAt: r.retired_at ? (iso(r.retired_at) as string) : null,
  positions: Number(r.position_count ?? 0),
  createdAt: iso(r.created_at) as string,
});

const SKILL_SELECT = sql`
  select k.*, c.label as category_label,
         (select count(*)::int from public.competence_position_skills ps join public.competence_positions p on p.id = ps.position_id where ps.skill_id = k.id and p.active) as position_count
    from public.competence_skills k join public.competence_categories c on c.id = k.category_id`;

@Injectable()
export class CompetenceService {
  constructor(private readonly database: DatabaseService) {}

  // ---- categories ----------------------------------------------------------------------------------

  categories(ctx: RequestContext, q: AllQuery): Promise<{ data: Category[] }> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select c.*, (select count(*)::int from public.competence_skills k where k.category_id = c.id) as skill_count
          from public.competence_categories c
         where c.organisation_id = ${orgOf(ctx)}::uuid ${q.all === 'true' ? sql`` : sql`and c.active`}
         order by c.sequence, lower(c.label)`);
      return { data: res.rows.map(toCategory) };
    });
  }

  createCategory(ctx: RequestContext, body: CreateCategoryBody): Promise<Category> {
    return this.database.asUser(ctx, async (db) => {
      // The key is made from the label and kept: renaming later never changes it.
      const base = body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'category';
      let key = /^[a-z]/.test(base) ? base : `c_${base}`;
      for (let i = 2; ; i++) {
        const taken = await db.execute(sql`select 1 from public.competence_categories where organisation_id = ${orgOf(ctx)}::uuid and key = ${key}`);
        if (taken.rows.length === 0) break;
        key = `${base.slice(0, 34)}_${i}`;
      }
      const res = await db.execute<Row>(sql`
        insert into public.competence_categories (organisation_id, key, label, description, sequence)
        values (${orgOf(ctx)}::uuid, ${key}, ${body.label}, ${body.description ?? null},
                ${body.sequence ?? sql`(select coalesce(max(sequence), 0) + 1 from public.competence_categories where organisation_id = ${orgOf(ctx)}::uuid)`})
        returning *, 0 as skill_count`);
      return toCategory(res.rows[0]);
    });
  }

  updateCategory(ctx: RequestContext, id: string, body: UpdateCategoryBody): Promise<Category> {
    return this.database.asUser(ctx, async (db) => {
      const sets = assignments(body, CATEGORY_COLUMNS);
      const res = await db.execute<Row>(sql`
        update public.competence_categories set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid
        returning *, (select count(*)::int from public.competence_skills k where k.category_id = public.competence_categories.id) as skill_count`);
      if (res.rows.length === 0) throw ApiError.notFound('competence_category_not_found', 'Category not found');
      return toCategory(res.rows[0]);
    });
  }

  // ---- skills --------------------------------------------------------------------------------------

  skills(ctx: RequestContext, q: SkillListQuery): Promise<{ data: Skill[] }> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select * from (${SKILL_SELECT}) k
         where k.organisation_id = ${orgOf(ctx)}::uuid ${q.all === 'true' ? sql`` : sql`and k.active`}
           ${q.categoryId ? sql`and k.category_id = ${q.categoryId}::uuid` : sql``}
           ${q.q ? sql`and (k.name ilike ${likePattern(q.q)} escape '\\' or k.code ilike ${likePattern(q.q)} escape '\\')` : sql``}
         order by lower(k.category_label), lower(k.name)`);
      return { data: res.rows.map(toSkill) };
    });
  }

  private async loadSkill(db: Db, ctx: RequestContext, id: string): Promise<Skill> {
    const res = await db.execute<Row>(sql`select * from (${SKILL_SELECT}) k where k.id = ${id}::uuid and k.organisation_id = ${orgOf(ctx)}::uuid`);
    if (res.rows.length === 0) throw ApiError.notFound('competence_skill_not_found', 'Skill not found');
    return toSkill(res.rows[0]);
  }

  createSkill(ctx: RequestContext, body: CreateSkillBody): Promise<Skill> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.save_competence_skill(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb) as id`);
      return this.loadSkill(db, ctx, res.rows[0].id);
    });
  }

  updateSkill(ctx: RequestContext, id: string, body: UpdateSkillBody): Promise<Skill> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadSkill(db, ctx, id);
      await db.execute(sql`select app.save_competence_skill(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb, ${id}::uuid)`);
      return this.loadSkill(db, ctx, id);
    });
  }

  retireSkill(ctx: RequestContext, id: string, body: ReasonBody): Promise<Skill> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadSkill(db, ctx, id);
      await db.execute(sql`select app.retire_competence_skill(${id}::uuid, ${body.reason})`);
      return this.loadSkill(db, ctx, id);
    });
  }

  reactivateSkill(ctx: RequestContext, id: string): Promise<Skill> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadSkill(db, ctx, id);
      await db.execute(sql`select app.reactivate_competence_skill(${id}::uuid)`);
      return this.loadSkill(db, ctx, id);
    });
  }

  // ---- positions -----------------------------------------------------------------------------------

  private async loadPositions(db: Db, ctx: RequestContext, where: ReturnType<typeof sql>): Promise<Position[]> {
    const res = await db.execute<Row>(sql`
      select p.*,
             coalesce((select jsonb_agg(jsonb_build_object('skillId', k.id, 'code', k.code, 'name', k.name, 'category', c.label, 'requiredLevel', ps.required_level, 'skillActive', k.active)
                                        order by lower(c.label), lower(k.name))
                         from public.competence_position_skills ps
                         join public.competence_skills k on k.id = ps.skill_id
                         join public.competence_categories c on c.id = k.category_id
                        where ps.position_id = p.id), '[]'::jsonb) as skills
        from public.competence_positions p
       where p.organisation_id = ${orgOf(ctx)}::uuid ${where}
       order by lower(p.name)`);
    return res.rows.map((r) => ({
      id: r.id as string,
      code: r.code as string,
      name: r.name as string,
      description: (r.description as string) ?? null,
      active: !!r.active,
      retiredReason: (r.retired_reason as string) ?? null,
      retiredAt: r.retired_at ? (iso(r.retired_at) as string) : null,
      skills: z.array(PositionSkill).parse(r.skills),
      createdAt: iso(r.created_at) as string,
    }));
  }

  positions(ctx: RequestContext, q: AllQuery): Promise<{ data: Position[] }> {
    return this.database.asUser(ctx, async (db) => ({ data: await this.loadPositions(db, ctx, q.all === 'true' ? sql`` : sql`and p.active`) }));
  }

  private async onePosition(db: Db, ctx: RequestContext, id: string): Promise<Position> {
    const found = await this.loadPositions(db, ctx, sql`and p.id = ${id}::uuid`);
    if (found.length === 0) throw ApiError.notFound('competence_position_not_found', 'Position not found');
    return found[0];
  }

  position(ctx: RequestContext, id: string): Promise<Position> {
    return this.database.asUser(ctx, (db) => this.onePosition(db, ctx, id));
  }

  createPosition(ctx: RequestContext, body: CreatePositionBody): Promise<Position> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.save_competence_position(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb) as id`);
      return this.onePosition(db, ctx, res.rows[0].id);
    });
  }

  updatePosition(ctx: RequestContext, id: string, body: UpdatePositionBody): Promise<Position> {
    return this.database.asUser(ctx, async (db) => {
      await this.onePosition(db, ctx, id);
      await db.execute(sql`select app.save_competence_position(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb, ${id}::uuid)`);
      return this.onePosition(db, ctx, id);
    });
  }

  setPositionSkills(ctx: RequestContext, id: string, body: SetPositionSkillsBody): Promise<Position> {
    return this.database.asUser(ctx, async (db) => {
      await this.onePosition(db, ctx, id);
      await db.execute(sql`select app.set_position_skills(${id}::uuid, ${JSON.stringify(body.skills)}::jsonb)`);
      return this.onePosition(db, ctx, id);
    });
  }

  retirePosition(ctx: RequestContext, id: string, body: ReasonBody): Promise<Position> {
    return this.database.asUser(ctx, async (db) => {
      await this.onePosition(db, ctx, id);
      await db.execute(sql`select app.retire_competence_position(${id}::uuid, ${body.reason})`);
      return this.onePosition(db, ctx, id);
    });
  }

  reactivatePosition(ctx: RequestContext, id: string): Promise<Position> {
    return this.database.asUser(ctx, async (db) => {
      await this.onePosition(db, ctx, id);
      await db.execute(sql`select app.reactivate_competence_position(${id}::uuid)`);
      return this.onePosition(db, ctx, id);
    });
  }
}
