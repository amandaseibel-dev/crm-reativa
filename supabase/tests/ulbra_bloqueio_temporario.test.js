import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'aguardando_aprovacao')
const lerSql = (n) => readFileSync(join(DIR, n), 'utf8')

async function ambiente() {
  const db = new PGlite()
  await db.exec(`
    create role authenticated; create role anon;
    create function public.ulbra_central_operador(text, integer, integer) returns jsonb
      language sql as $$ select '{}'::jsonb $$;
    create function public.ulbra_avisos_operador(integer) returns jsonb
      language sql as $$ select '{}'::jsonb $$;
    grant execute on function public.ulbra_central_operador(text, integer, integer) to authenticated;
    grant execute on function public.ulbra_avisos_operador(integer) to authenticated;
  `)
  return db
}

const pode = async (db, fn, args) => {
  const r = await db.query(`select has_function_privilege('authenticated', '${fn}', 'EXECUTE') as ok`)
  return r.rows[0].ok
}

describe('bloqueio temporário ULBRA (20261110160000)', () => {
  it('remove EXECUTE de authenticated nas duas RPCs', async () => {
    const db = await ambiente()
    expect(await pode(db, 'public.ulbra_central_operador(text,integer,integer)')).toBe(true)
    await db.exec(lerSql('20261110160000_ulbra_bloqueio_temporario.sql.pendente'))
    expect(await pode(db, 'public.ulbra_central_operador(text,integer,integer)')).toBe(false)
    expect(await pode(db, 'public.ulbra_avisos_operador(integer)')).toBe(false)
  })

  it('rollback devolve EXECUTE só às versões atuais', async () => {
    const db = await ambiente()
    await db.exec(lerSql('20261110160000_ulbra_bloqueio_temporario.sql.pendente'))
    await db.exec(lerSql('20261110160000_ulbra_bloqueio_temporario.rollback.sql'))
    expect(await pode(db, 'public.ulbra_central_operador(text,integer,integer)')).toBe(true)
    expect(await pode(db, 'public.ulbra_avisos_operador(integer)')).toBe(true)
  })

  it('não é restaurado acesso por versão antiga: o arquivo não cria função', () => {
    const sql = lerSql('20261110160000_ulbra_bloqueio_temporario.sql.pendente')
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function/i)
  })
})
