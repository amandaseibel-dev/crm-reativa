-- Acoes Massivas: varias unidades de uma vez + filtro de matricula.
--
-- Amanda, 28/08/2026, em sequencia:
--   "nao consta nenhum aluno campus canoas"
--   "algumas unidades ja encerrou, preciso selecionar alguma unidades"
--   "quero ter acesso a todos que nao realizaram a matricula que nao esta confirmado"
--   "as demais fora o ead e o pop acaba hoje"
--
-- TRES PROBLEMAS:
--
-- 1) A previa nao devolvia a unidade de cada aluno. O filtro FUNCIONAVA no
--    banco (CAMPUS CANOAS = 567 elegiveis), mas a tela nao mostrava a unidade
--    -- entao parecia que nao havia ninguem daquele campus.
--
-- 2) O filtro aceitava UMA unidade so. Com unidades encerradas (Santarem e
--    Manaus) e outras encerrando a matricula hoje, ela precisa marcar um
--    subconjunto.
--
-- 3) Nao havia como separar quem NAO confirmou matricula -- que e justamente
--    o publico da acao de hoje.
--
-- COMO FICOU, sem quebrar quem ja chamava:
--   * `p_unidade` aceita varias unidades separadas por "|". Uma sozinha
--     continua funcionando igual.
--   * novo `p_matricula`: 'NAO_CONFIRMADA' | 'CONFIRMADA' | NULL.
--     A matricula vem do Prime (`prime_contratos`) casada por CPF, no semestre
--     corrente. Confirmado = matricula fechada; Aberto ou inexistente = nao
--     confirmada.
--   * a previa passa a devolver `unidade` de cada aluno.
--
-- Medido: 5.965 elegiveis com matricula nao confirmada. Fora EAD (1.229),
-- ULBRA POP (911), Santarem e Manaus (encerradas) e os 2.274 sem unidade
-- registrada, sobram 1.154 nas unidades que encerram hoje.

create or replace function public.semestre_corrente_inicio()
returns date
language sql
immutable
as $$
  select case when extract(month from current_date) <= 6
              then make_date(extract(year from current_date)::int, 1, 1)
              else make_date(extract(year from current_date)::int, 7, 1) end;
$$;

-- A alteracao da previa e cirurgica: le a definicao vigente, troca as linhas
-- necessarias e recria. O resto do corpo fica byte a byte identico.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[])'::regprocedure);

  v_def := replace(v_def,
    '(p_unidade IS NULL OR a.unidade = p_unidade)',
    '(p_unidade IS NULL OR a.unidade = ANY(string_to_array(p_unidade, ''|'')))');

  v_def := replace(v_def,
    'nullif(btrim(a.curso),'''')              AS curso,',
    'nullif(btrim(a.curso),'''')              AS curso,
           a.unidade,');

  v_def := replace(v_def, 'cademica, curso,', 'cademica, curso, unidade,');

  v_def := replace(v_def, '''curso'', curso,', '''curso'', curso,
        ''unidade'', unidade,');

  v_def := replace(v_def,
    'p_importacao_ids uuid[] DEFAULT NULL::uuid[])',
    'p_importacao_ids uuid[] DEFAULT NULL::uuid[], p_matricula text DEFAULT NULL::text)');

  v_def := replace(v_def,
    '      AND (p_curso   IS NULL OR a.curso   = p_curso)',
    '      AND (p_matricula IS NULL OR (
        CASE WHEN EXISTS (
               SELECT 1 FROM public.prime_contratos pc
                WHERE pc.cpf = lpad(regexp_replace(coalesce(a.cpf,''''),''\D'','''',''g''),11,''0'')
                  AND pc.valid_from >= public.semestre_corrente_inicio()
                  AND pc.status = ''Confirmado'')
             THEN ''CONFIRMADA'' ELSE ''NAO_CONFIRMADA'' END = p_matricula))
      AND (p_curso   IS NULL OR a.curso   = p_curso)');

  execute v_def;
end $$;

revoke all on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text) from public, anon;
grant execute on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text) to authenticated, service_role;
