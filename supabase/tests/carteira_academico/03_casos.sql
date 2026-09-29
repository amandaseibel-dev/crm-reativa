-- CASOS. Rodam DEPOIS do SQL aplicado, no banco isolado.
-- Cada caso falha FECHADO: `raise exception` derruba o psql (ON_ERROR_STOP).
--
-- O QUE ESTE ARQUIVO EXISTE PARA PEGAR, antes de tudo: a referência ambígua a
-- `cpf` no ramo de 2024/2025. Com a versão defeituosa, os dois primeiros casos
-- morrem em `42702 column reference "cpf" is ambiguous` -- não é asserção que
-- falha, é a função que não executa. Foi assim em produção em 29/09/2026:
-- 2026/1 e 2026/2 responderam, 2024 e 2025 não.
\set ON_ERROR_STOP on

create or replace function public.t_igual(p_obtido anyelement, p_esperado anyelement, p_verbete text)
returns void language plpgsql as $$
begin
  if p_obtido is distinct from p_esperado then
    raise exception 'FALHOU [%]: esperado "%", veio "%"', p_verbete, p_esperado, p_obtido;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. OS QUATRO RECORTES EXECUTAM e contam ALUNO ÚNICO
-- ---------------------------------------------------------------------------
do $$
declare n integer;
begin
  -- 2024 e 2025 PRIMEIRO, de propósito: são os que a versão defeituosa derruba.
  select count(*) into n from public.carteira_academico_universo('2024');
  perform public.t_igual(n, 1, '2024 -- universo (B1 entra; B2 sai pelo portador 166)');

  select count(*) into n from public.carteira_academico_universo('2025');
  perform public.t_igual(n, 1, '2025 -- universo (C1 entra; C2 sai por caso CANCELADO)');

  select count(*) into n from public.carteira_academico_universo('2026','1');
  perform public.t_igual(n, 1, '2026/1 -- universo (A1 dedup por CPF; A2 tem saldo zero)');

  select count(*) into n from public.carteira_academico_universo('2026','2');
  perform public.t_igual(n, 2, '2026/2 -- universo (D1 tem dois titulos, vira um aluno)');
end $$;

-- ---------------------------------------------------------------------------
-- 2. SEM DUPLICAÇÃO -- uma linha por aluno, em qualquer recorte
-- ---------------------------------------------------------------------------
do $$
declare r record; linhas integer; cpfs integer; ids integer;
begin
  for r in select * from (values ('2024',null),('2025',null),('2026','1'),('2026','2')) v(ano, sem)
  loop
    select count(*), count(distinct u.cpf), count(distinct u.aluno_id)
      into linhas, cpfs, ids
      from public.carteira_academico_universo(r.ano, r.sem) u;
    if linhas <> cpfs then
      raise exception 'FALHOU [% -- CPF repetido]: % linhas para % CPFs distintos',
        r.ano, linhas, cpfs;
    end if;
    if linhas <> ids then
      raise exception 'FALHOU [% -- aluno repetido]: % linhas para % aluno_id distintos',
        r.ano, linhas, ids;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. O PERFIL FECHA COM O UNIVERSO, e os grupos somam o total
-- ---------------------------------------------------------------------------
-- Cada chamada em sua própria instrução: `carteira_academico_perfil` cria a
-- temporária `_uni` com `on commit drop`, e duas chamadas na MESMA transação
-- colidiriam. O PostgREST abre uma transação por chamada, então isto não
-- acontece em produção -- mas num bloco `do $$` aconteceria.
do $$
declare p jsonb; universo integer; soma integer;
begin
  p := public.carteira_academico_perfil('2024');
  select count(*) into universo from public.carteira_academico_universo('2024');
  perform public.t_igual((p->>'total_alunos')::int, universo, '2024 -- perfil x universo');
  select coalesce(sum((g->>'alunos')::int),0) into soma
    from jsonb_array_elements(p->'grupos') g;
  perform public.t_igual(soma, universo, '2024 -- soma dos grupos = total de alunos unicos');
  perform public.t_igual(p->>'recorte', '2024', '2024 -- rotulo do recorte');
end $$;

do $$
declare p jsonb; universo integer; soma integer;
begin
  p := public.carteira_academico_perfil('2025');
  select count(*) into universo from public.carteira_academico_universo('2025');
  perform public.t_igual((p->>'total_alunos')::int, universo, '2025 -- perfil x universo');
  select coalesce(sum((g->>'alunos')::int),0) into soma
    from jsonb_array_elements(p->'grupos') g;
  perform public.t_igual(soma, universo, '2025 -- soma dos grupos = total de alunos unicos');
end $$;

do $$
declare p jsonb; universo integer; soma integer;
begin
  p := public.carteira_academico_perfil('2026','1');
  select count(*) into universo from public.carteira_academico_universo('2026','1');
  perform public.t_igual((p->>'total_alunos')::int, universo, '2026/1 -- perfil x universo');
  select coalesce(sum((g->>'alunos')::int),0) into soma
    from jsonb_array_elements(p->'grupos') g;
  perform public.t_igual(soma, universo, '2026/1 -- soma dos grupos = total de alunos unicos');
  perform public.t_igual(p->>'recorte', '2026/1', '2026/1 -- rotulo do recorte');
end $$;

do $$
declare p jsonb; universo integer; soma integer;
begin
  p := public.carteira_academico_perfil('2026','2');
  select count(*) into universo from public.carteira_academico_universo('2026','2');
  perform public.t_igual((p->>'total_alunos')::int, universo, '2026/2 -- perfil x universo');
  select coalesce(sum((g->>'alunos')::int),0) into soma
    from jsonb_array_elements(p->'grupos') g;
  perform public.t_igual(soma, universo, '2026/2 -- soma dos grupos = total de alunos unicos');
end $$;

-- ---------------------------------------------------------------------------
-- 4. OS GRUPOS SÃO OS DA CONSULTA, e a importação NÃO entra na soma
-- ---------------------------------------------------------------------------
do $$
declare p jsonb; g text;
begin
  -- 2024: B1 tem dois vinculos com o MESMO status -> um status identificado.
  p := public.carteira_academico_perfil('2024');
  select gg->>'grupo' into g from jsonb_array_elements(p->'grupos') gg limit 1;
  perform public.t_igual(g, 'Status identificado: EVADIDO',
                         '2024 -- dois vinculos de mesmo status viram UM grupo');
  -- a importacao vem a parte, rotulada, e nao soma nos grupos
  perform public.t_igual(p->'importacao'->>'fonte',
                         'Relatório de inadimplência (importação)',
                         '2024 -- a importacao vem rotulada como importacao');
end $$;

do $$
declare p jsonb; g text;
begin
  -- 2025: C1 tem dois status diferentes -> "Múltiplas situações", nunca um deles.
  p := public.carteira_academico_perfil('2025');
  select gg->>'grupo' into g from jsonb_array_elements(p->'grupos') gg limit 1;
  perform public.t_igual(g, 'Múltiplas situações',
                         '2025 -- status divergentes nao viram status da pessoa');
end $$;

do $$
declare p jsonb; grupos text;
begin
  -- 2026/2: D1 = SEM_RESULTADO, D2 = so consulta incompleta.
  p := public.carteira_academico_perfil('2026','2');
  select string_agg(gg->>'grupo', ' | ' order by gg->>'grupo')
    into grupos from jsonb_array_elements(p->'grupos') gg;
  perform public.t_igual(grupos, 'Informação incompleta | Sem resultado na busca',
                         '2026/2 -- incompleta e sem resultado sao grupos DISTINTOS');
end $$;

do $$
declare p jsonb; g text;
begin
  -- 2026/1: A1 nunca foi consultado. NAO pode ser preenchido com o rotulo da
  -- importacao ("ATIVO") nem com status de contrato.
  p := public.carteira_academico_perfil('2026','1');
  select gg->>'grupo' into g from jsonb_array_elements(p->'grupos') gg limit 1;
  perform public.t_igual(g, 'Ainda não consultados',
                         '2026/1 -- nao consultado continua nao consultado');
end $$;

-- ---------------------------------------------------------------------------
-- 5. DETALHAMENTO -- os alunos do grupo, com TODAS as situações
-- ---------------------------------------------------------------------------
do $$
declare d jsonb; a jsonb;
begin
  d := public.carteira_academico_detalhe('2025', null, 'Múltiplas situações');
  perform public.t_igual(jsonb_array_length(d->'alunos'), 1,
                         '2025 -- detalhamento traz um aluno no grupo');
  a := d->'alunos'->0;
  perform public.t_igual(a->>'nome', 'ALUNO C1', '2025 -- detalhamento identifica o aluno');
  perform public.t_igual(jsonb_array_length(a->'situacoes'), 2,
                         '2025 -- as DUAS situacoes aparecem, sem escolher uma');
  perform public.t_igual(a->'situacoes'->0->>'status', 'FORMADO',
                         '2025 -- situacoes na ordem da API');
  perform public.t_igual(a->>'situacao_importada', 'FORMADO',
                         '2025 -- a importacao aparece em campo PROPRIO');
end $$;

do $$
declare d jsonb;
begin
  -- grupo que nao existe devolve lista vazia, nunca a carteira inteira
  d := public.carteira_academico_detalhe('2024', null, 'Grupo Inexistente');
  perform public.t_igual(jsonb_array_length(d->'alunos'), 0,
                         '2024 -- grupo inexistente devolve vazio');
end $$;

-- ---------------------------------------------------------------------------
-- 6. RECORTE INEXISTENTE devolve VAZIO, nunca a carteira inteira
-- ---------------------------------------------------------------------------
do $$
declare n integer;
begin
  select count(*) into n from public.carteira_academico_universo('2023');
  perform public.t_igual(n, 0, 'recorte inexistente nao vira painel cheio');
  select count(*) into n from public.carteira_academico_universo('2026','9');
  perform public.t_igual(n, 0, 'semestre inexistente nao vira painel cheio');
end $$;

-- ---------------------------------------------------------------------------
-- 7. PERMISSÕES -- `anon` fora, gestão dentro
-- ---------------------------------------------------------------------------
-- Vale por si: as default privileges do Supabase concedem EXECUTE a `anon` em
-- toda função nova, e `revoke ... from public` não desfaz isso -- a concessão
-- é direta ao papel. O ambiente deste teste reproduz as default privileges,
-- então este caso falharia se a migration revogasse só de PUBLIC.
do $$
declare r record;
begin
  for r in
    select unnest(array[
      'public.carteira_academico_universo(text,text)',
      'public.carteira_academico_perfil(text,text)',
      'public.carteira_academico_detalhe(text,text,text,integer)',
      'public.carteira_academico_grupo(uuid)'
    ]) f
  loop
    if has_function_privilege('anon', r.f, 'EXECUTE') then
      raise exception 'FALHOU [permissao]: anon ainda executa %', r.f;
    end if;
    if not has_function_privilege('authenticated', r.f, 'EXECUTE') then
      raise exception 'FALHOU [permissao]: authenticated PERDEU execute em %', r.f;
    end if;
    if not has_function_privilege('service_role', r.f, 'EXECUTE') then
      raise exception 'FALHOU [permissao]: service_role perdeu execute em %', r.f;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 8. O PERFIL SEGUE STABLE e não cria tabela
-- ---------------------------------------------------------------------------
-- O defeito era `create temp table` numa função STABLE: ela nunca executava.
-- Trocar para VOLATILE "resolveria" e mudaria a natureza da função, então a
-- volatilidade é asserida junto com o resultado.
do $$
declare v char;
begin
  select provolatile into v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='carteira_academico_perfil';
  if v <> 's' then
    raise exception 'FALHOU [volatilidade]: carteira_academico_perfil deveria ser STABLE, esta "%"', v;
  end if;
  -- OS COMENTARIOS SAO FILTRADOS ANTES DE PROIBIR. O corpo novo EXPLICA o
  -- defeito e cita "create temp table" em comentario; sem tirar os comentarios
  -- a assercao acusaria a propria explicacao. Foi o que aconteceu na primeira
  -- execucao deste caso.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'carteira_academico%'
       and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ilike '%create temp table%'
  ) then
    raise exception 'FALHOU [volatilidade]: voltou a criar tabela temporaria';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. O DETALHAMENTO MASCARA O CPF de verdade
-- ---------------------------------------------------------------------------
-- `alunos.cpf_mascarado` NAO mascara em producao (15.841 de 15.841 com o CPF
-- inteiro). O baseline reproduz isso: ALUNO C1 tem '555.555.555-55' naquela
-- coluna. Se a funcao voltar a confiar nela, este caso pega.
do $$
declare d jsonb; m text;
begin
  d := public.carteira_academico_detalhe('2025', null, 'Múltiplas situações');
  m := d->'alunos'->0->>'cpf_mascarado';
  if m is null then
    raise exception 'FALHOU [mascara]: cpf_mascarado veio nulo';
  end if;
  if m not like '%*%' then
    raise exception 'FALHOU [mascara]: CPF saiu INTEIRO no detalhamento: "%"', m;
  end if;
  perform public.t_igual(m, '555.***.555-**', 'mascara no formato da funcao irma');
end $$;

select 'TODOS OS CASOS PASSARAM' as resultado;
