-- ROLLBACK de 20260926143256_trava_vigia_carteira_geral
--
-- Devolve public.carteira_geral_vigia() ao corpo de 20260925181823 -- `language
-- sql`, SEM portao de gestao. Depois disto, qualquer `authenticated` volta a ler
-- a lista de nomes de quem a gestao desligou. Rode isto sabendo disso.
--
-- O corpo abaixo foi extraido do proprio arquivo da 20260925181823 e confere com
-- o que estava em producao antes da trava: md5(prosrc) = c3ed8f59a439440536677ba3660e12f4
-- (1.240 chars).
--
-- NAO mexe em grants: a trava nao mudou a ACL (postgres=X | authenticated=X |
-- service_role=X antes e depois), entao nao ha o que restaurar ali.

do $precondicao$
declare v_md5 text;
begin
  select md5(p.prosrc) into v_md5
    from pg_proc p where p.oid = 'public.carteira_geral_vigia()'::regprocedure;

  if v_md5 = 'c3ed8f59a439440536677ba3660e12f4' then
    raise notice 'rollback ja aplicado: o corpo vivo ja e o de 20260925181823.';
    return;
  end if;

  if v_md5 <> 'ed04170d2f95876ed2dcf4ae15c6d770' then
    raise exception
      'o corpo vivo de carteira_geral_vigia() nao e o que 20260926143256 instalou (md5 vivo %, esperado ed04170d2f95876ed2dcf4ae15c6d770). Alguem mexeu depois: leia a funcao antes de reverter.',
      v_md5;
  end if;
end
$precondicao$;

create or replace function public.carteira_geral_vigia()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
  select jsonb_build_object(
    'na_carteira_geral', (select count(*) from public.casos
                           where lower(coalesce(operador_email,'')) = internal.carteira_geral_email()),
    'acordos_na_carteira_geral', (select count(*) from public.acordos
                                   where lower(coalesce(operador_responsavel_email,'')) = internal.carteira_geral_email()),
    'operadores_sem_entrada_de_casos', (select coalesce(jsonb_agg(nome order by nome), '[]'::jsonb)
                                      from public.usuarios
                                     where perfil = 'operador'
                                       and (not ativo or not coalesce(recebe_novos_casos, true))),
    -- casos que sairam da Carteira Geral sem passar por carteira_geral_mover:
    -- a auditoria registra toda saida legitima.
    'saidas_sem_auditoria', (
      select count(*) from public.historico_operadores_alunos h
       where h.operador_anterior_email = internal.carteira_geral_email()
         and not exists (select 1 from public.carteira_geral_auditoria a
                          where a.aluno_id = h.aluno_id and a.registrado_em between h.criado_em - interval '1 minute' and h.criado_em + interval '1 minute'))
  );
$fn$;

-- A ACL fica como esta; estas duas linhas so a reafirmam, como na 20260925181823.
revoke all on function public.carteira_geral_vigia() from public, anon;
grant execute on function public.carteira_geral_vigia() to authenticated;

comment on function public.carteira_geral_vigia() is null;
