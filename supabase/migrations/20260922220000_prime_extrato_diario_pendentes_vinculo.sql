-- ATUALIZACAO DIARIA DO PRIME_EXTRATO PARA O GRUPO B (AGUARDANDO DADO).
-- Medido em 22/09: extrato so era atualizado semanalmente (prime_extrato_mutirao/reenfileirar_semanal, so
-- sabado), o que limitava a maturacao dos ~2.413 titulos/R$ 3,7 mi presos em SEM_EVIDENCIA por liquidacao
-- ainda nao real. O vinculo ja reprocessa a cada 15 min (PR #449/#450) -- a lacuna era so a frequencia do
-- dado de origem.
--
-- MENOR MUDANCA POSSIVEL: nao toca a logica do vinculo, nao toca a busca no Prime (mesma funcao
-- prime_extrato_mutirao(), mesma Edge Function, mesmo teto de tempo/concorrencia ja validado em producao
-- com a base inteira -- 17.741 matriculas, sem erro de rate limit conhecido). So adiciona um enfileirador
-- ESCOPADO: em vez de reenfileirar toda a base (mutirao semanal, ~17.741), reenfileira SOMENTE as matriculas
-- de alunos com acordo ATIVO/QUITADO sem vinculo E mensalidade original ABERTO/EM_CONFIRMACAO livre
-- (universo do grupo B -- ~842 alunos, 20x menor que o mutirao semanal). Roda 1x/dia; o consumo reusa
-- prime_extrato_mutirao() ja existente, chamado algumas vezes no mesmo dia para drenar o lote pequeno.
-- Nao mexe no job semanal (prime_extrato_mutirao/reenfileirar_semanal), que continua cobrindo a base toda.
begin;

create or replace function public.prime_extrato_reenfileirar_pendentes_vinculo()
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare v_n integer;
begin
  insert into public.prime_extrato_fila (matricula, cpf, motivo, tentativas, criado_em)
  select distinct al.matricula, al.cpf, 'pendente_vinculo_diario', 0, now()
    from public.acordos a
    join public.alunos al on al.id = a.aluno_id
   where upper(coalesce(a.status, '')) in ('ATIVO', 'QUITADO')
     and al.matricula is not null and al.matricula <> ''
     -- acordo sem vinculo ativo com mensalidade original
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos_titulos t on t.id = v.titulo_id and coalesce(t.tipo_boleto, '') <> 'Acordo'
        where v.acordo_id = a.id and coalesce(v.ativo, true)
     )
     -- e existe mensalidade original ABERTO/EM_CONFIRMACAO, livre, do mesmo aluno (o universo que pode amadurecer)
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

-- Enfileira 1x/dia (fora do :40 e fora da janela do mutirao semanal de sabado).
select cron.schedule('prime_extrato_pendentes_vinculo_enfileirar', '10 3 * * *',
  $cron$select public.prime_extrato_reenfileirar_pendentes_vinculo();$cron$);

-- Drena a fila com a MESMA funcao de consumo ja em producao (sem logica nova), algumas vezes ao longo do
-- dia -- lote pequeno (~842), sobra folga grande sobre o lote de 400/chamada ja usado no mutirao semanal.
select cron.schedule('prime_extrato_pendentes_vinculo_drenar', '15,35,55 3 * * *',
  $cron$select public.prime_extrato_mutirao();$cron$);

commit;
