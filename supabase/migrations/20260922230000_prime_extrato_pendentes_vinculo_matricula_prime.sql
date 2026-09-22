-- CORRECAO: 20260922220000 enfileirou por alunos.matricula (ID interno do CRM, ex. "668"), nao pela
-- matricula/registration REAL do Prime (ex. "222000794"). Resultado medido na primeira rodada em producao:
-- 714 matriculas enfileiradas, 714 erros "prime 404" -- 100% de falha, porque nenhuma delas existe como
-- registration no Prime. A fonte correta e prime_contratos.registration, casado por CPF -- o MESMO caminho
-- que prime_extrato_reenfileirar() (mutirao semanal) ja usa. Mesmo erro que este arquivo corrige agora.
-- Nao muda nada mais: mesma logica de selecao do universo (grupo B), mesmos jobs, mesmo consumo.
begin;

create or replace function public.prime_extrato_reenfileirar_pendentes_vinculo()
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare v_n integer;
begin
  insert into public.prime_extrato_fila (matricula, cpf, motivo, tentativas, criado_em)
  select distinct c.registration, c.cpf, 'pendente_vinculo_diario', 0, now()
    from public.acordos a
    join public.alunos al on al.id = a.aluno_id
    join lateral (
      select distinct on (cpf) cpf, registration from public.prime_contratos
       where lpad(regexp_replace(cpf, '\D', '', 'g'), 11, '0') = lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0')
       order by cpf, valid_from desc
       limit 1
    ) c on true
   where upper(coalesce(a.status, '')) in ('ATIVO', 'QUITADO')
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos_titulos t on t.id = v.titulo_id and coalesce(t.tipo_boleto, '') <> 'Acordo'
        where v.acordo_id = a.id and coalesce(v.ativo, true)
     )
     and exists (
       select 1 from public.acordos_titulos t2
        where t2.aluno_id = a.aluno_id and coalesce(t2.tipo_boleto, '') <> 'Acordo'
          and upper(coalesce(t2.situacao, '')) in ('ABERTO', 'EM_CONFIRMACAO')
          and t2.acordo_id is null
          and not exists (select 1 from public.acordo_titulo_vinculo v2 where v2.titulo_id = t2.id and coalesce(v2.ativo, true))
     )
  on conflict (matricula) do update
     set coletado_em = null, tentativas = 0, ultimo_erro = null, motivo = excluded.motivo, criado_em = excluded.criado_em;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

revoke all on function public.prime_extrato_reenfileirar_pendentes_vinculo() from public, anon, authenticated;
grant execute on function public.prime_extrato_reenfileirar_pendentes_vinculo() to service_role;

commit;
