-- Pesquisa na base por TELEFONE.
-- Pedido da operação (2026-08-21): a busca aceitava só nome/CPF/matrícula.
-- Telefones estão gravados em formatos variados (com/sem +55, com/sem 9º
-- dígito, com máscara). Casamos pelos 8 últimos dígitos e, quando o termo traz
-- DDD, exigimos o DDD também (tolerando o 9º dígito e o prefixo 55).
-- Ordem: matrícula exata > CPF por trecho ∪ telefone. Mantém gate/limites.
create or replace function public.buscar_aluno(p_termo text)
 returns setof public.alunos
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_so_numeros text := regexp_replace(coalesce(p_termo,''), '\D', '', 'g');
  v_termo_normalizado text;
  v_tem_matricula boolean;
  v_fone text;
  v_fone8 text;
  v_ddd text;
  v_regex text;
begin
  if length(v_so_numeros) >= 3 then
    v_tem_matricula :=
      exists (select 1 from public.alunos a where a.matricula = v_so_numeros)
      or exists (select 1 from public.casos c where c.matricula = v_so_numeros);

    if v_tem_matricula then
      return query
      select a.*
      from public.alunos a
      where a.matricula = v_so_numeros
         or a.id in (select c.aluno_id from public.casos c where c.matricula = v_so_numeros)
      order by a.nome
      limit 150;
      return;
    end if;

    -- Telefone: só com 8+ dígitos. Tira o 55 inicial se veio com país.
    v_fone := v_so_numeros;
    if length(v_fone) in (12, 13) and v_fone like '55%' then
      v_fone := substr(v_fone, 3);
    end if;
    if length(v_fone) >= 8 and length(v_fone) <= 11 then
      v_fone8 := right(v_fone, 8);
      v_ddd := case when length(v_fone) >= 10 then left(v_fone, 2) else null end;
      -- ^(55)?DDD9?NNNNNNNN$  (sem DDD no termo: qualquer DDD)
      v_regex := '^(55)?' || coalesce(v_ddd, '[0-9]{2}') || '9?' || v_fone8 || '$';
    end if;

    return query
    select distinct on (a.id) a.*
    from public.alunos a
    where a.cpf ilike '%' || v_so_numeros || '%'
       or (v_regex is not null and (
            regexp_replace(coalesce(a.telefone,''), '\D', '', 'g') ~ v_regex
         or regexp_replace(coalesce(a.telefone_resp1,''), '\D', '', 'g') ~ v_regex
         or regexp_replace(coalesce(a.telefone_resp2,''), '\D', '', 'g') ~ v_regex))
    order by a.id
    limit 150;
    return;
  end if;

  v_termo_normalizado := lower(translate(coalesce(p_termo,''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuuc AAAAAEEEEIIIIOOOOOUUUUC'));

  return query
  select * from public.alunos a
  where a.nome_normalizado ilike '%' || v_termo_normalizado || '%'
  limit 150;
end;
$function$;
