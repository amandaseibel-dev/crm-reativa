-- Busca global por matrícula na RPC buscar_aluno.
--
-- Problema: buscar_aluno tratava QUALQUER termo com 3+ dígitos como CPF
-- (ilike em alunos.cpf). Matrículas (ex.: 12370, 12876) caíam nesse ramo e
-- nunca eram comparadas com alunos.matricula nem casos.matricula, então não
-- localizavam o aluno.
--
-- Regra final de prioridade (termo numérico com 3+ dígitos):
--   1) MATRÍCULA EXATA: procura em alunos.matricula E casos.matricula. Se
--      existir pelo menos uma correspondência exata, retorna SOMENTE os alunos
--      encontrados por matrícula -- NÃO acrescenta resultados por CPF parcial.
--   2) Caso não exista matrícula exata, mantém o comportamento LEGADO de busca
--      por CPF (ilike por trecho).
-- Termo não numérico: busca por NOME (comportamento legado).
--
-- Sem duplicidade por aluno_id: o SELECT lê apenas de public.alunos (uma linha
-- por aluno); casos.matricula é resolvido via subconsulta em aluno_id.
-- Comparação de matrícula por texto exato -> zeros à esquerda preservados;
-- espaços removidos por regexp_replace(..., '\D', ''). Nome/CPF não inferem
-- matrícula. Nenhuma tabela (alunos, casos, financeiro) é alterada. RLS/grants
-- inalterados -- anon continua sem acesso.

create or replace function public.buscar_aluno(p_termo text)
 returns setof alunos
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_so_numeros text := regexp_replace(coalesce(p_termo,''), '\D', '', 'g');
  v_termo_normalizado text;
  v_tem_matricula boolean;
begin
  if length(v_so_numeros) >= 3 then
    -- 1) Matrícula exata tem prioridade absoluta (alunos.matricula OU casos.matricula).
    v_tem_matricula :=
      exists (select 1 from public.alunos a where a.matricula = v_so_numeros)
      or exists (select 1 from public.casos c where c.matricula = v_so_numeros);

    if v_tem_matricula then
      -- Retorna SOMENTE alunos casados por matrícula. Sem CPF parcial.
      -- Uma linha por aluno_id (sem join -> sem duplicidade).
      return query
      select a.*
      from public.alunos a
      where a.matricula = v_so_numeros
         or a.id in (select c.aluno_id from public.casos c where c.matricula = v_so_numeros)
      order by a.nome
      limit 150;
      return;
    end if;

    -- 2) Sem matrícula exata: comportamento legado de CPF por trecho.
    return query
    select * from public.alunos a where a.cpf ilike '%' || v_so_numeros || '%' limit 150;
    return;
  end if;

  -- Termo não numérico: busca por NOME (legado). Liberada pra qualquer
  -- autenticado (receptivo localiza aluno de qualquer operador). Anon sem acesso.
  v_termo_normalizado := lower(translate(coalesce(p_termo,''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuuc AAAAAEEEEIIIIOOOOOUUUUC'));

  return query
  select * from public.alunos a
  where a.nome_normalizado ilike '%' || v_termo_normalizado || '%'
  limit 150;
end;
$function$;
