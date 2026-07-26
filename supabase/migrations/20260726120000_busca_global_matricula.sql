-- Busca global por matrícula na RPC buscar_aluno.
--
-- Problema: buscar_aluno tratava QUALQUER termo com 3+ dígitos como CPF
-- (ilike em alunos.cpf). Matrículas (ex.: 12370, 12876) caíam nesse ramo e
-- nunca eram comparadas com alunos.matricula nem casos.matricula, então não
-- localizavam o aluno.
--
-- Correção: no ramo numérico, além do CPF por trecho (comportamento antigo
-- preservado), passa a casar:
--   - alunos.matricula EXATA (texto, zeros à esquerda preservados);
--   - casos.matricula EXATA, resolvendo para o mesmo aluno_id.
--
-- Regras respeitadas:
--   - matrícula exata tem PRIORIDADE (rank 0) sobre o trecho de CPF (rank 1);
--   - nome/CPF NÃO são usados para inferir matrícula;
--   - retorna SETOF alunos selecionando só de public.alunos (uma linha por
--     aluno) -> quando alunos e casos têm matrículas diferentes para o mesmo
--     aluno_id, o aluno aparece UMA única vez;
--   - não escolhe matrícula canônica nem sobrescreve dados: alunos.matricula
--     é devolvida como está;
--   - comparação por texto exato -> não há strip de zeros à esquerda; espaços
--     são removidos por regexp_replace(..., '\D', '').
-- Nenhuma tabela (alunos, casos, dados financeiros) é alterada.

create or replace function public.buscar_aluno(p_termo text)
 returns setof alunos
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_so_numeros text := regexp_replace(coalesce(p_termo,''), '\D', '', 'g');
  v_termo_normalizado text;
begin
  -- Termo numérico (3+ dígitos): matrícula exata (alunos/casos) + CPF por trecho.
  -- Pontual, liberada pra qualquer autenticado. Anon segue sem acesso (SECURITY
  -- DEFINER + RLS/grants inalterados; login continua exigido).
  if length(v_so_numeros) >= 3 then
    return query
    select a.*
    from public.alunos a
    where a.matricula = v_so_numeros
       or a.id in (select c.aluno_id from public.casos c where c.matricula = v_so_numeros)
       or a.cpf ilike '%' || v_so_numeros || '%'
    order by
      -- Matrícula exata primeiro; depois trecho de CPF.
      (case
         when a.matricula = v_so_numeros
           or a.id in (select c.aluno_id from public.casos c where c.matricula = v_so_numeros)
         then 0 else 1
       end),
      a.nome
    limit 150;
    return;
  end if;

  -- Busca por NOME: liberada pra qualquer autenticado (necessario pro receptivo
  -- localizar aluno de qualquer operador). Anon continua sem acesso (exige login).
  v_termo_normalizado := lower(translate(coalesce(p_termo,''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuuc AAAAAEEEEIIIIOOOOOUUUUC'));

  return query
  select * from public.alunos a
  where a.nome_normalizado ilike '%' || v_termo_normalizado || '%'
  limit 150;
end;
$function$;
