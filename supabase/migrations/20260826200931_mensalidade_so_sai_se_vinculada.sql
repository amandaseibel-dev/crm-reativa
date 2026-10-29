-- Mensalidade só sai da conta se estiver VINCULADA a um acordo.
--
-- Amanda, 26/08/2026: "mensalidades em aberto, sem vincular devem continuar com
-- mensalidades em aberto, so sai se for vinculada, nao crie regras que nao
-- existem".
--
-- A REGRA INVENTADA. `titulo_superado_por_acordo` escondia a mensalidade sempre
-- que existisse QUALQUER acordo do aluno criado depois do vencimento dela --
-- dedução por calendário, sem nenhum vínculo real.
--
-- O caso que provou: Elionaldo Pereira de Amorim Junior. Quatro mensalidades de
-- set a dez/2025, R$ 3.312,75, todas ABERTO e SEM VÍNCULO. Nenhuma parcela de
-- acordo em aberto. O CRM mostrava saldo R$ 0,00.
--
-- A REGRA DE VERDADE: a mensalidade sai da conta quando alguém A VINCULA ao
-- acordo. Enquanto não vincular, continua em aberto -- que é o que ela é.
--
-- IMPACTO: 4.368 títulos, 1.432 alunos, R$ 6.229.309,16 voltam a contar.
--
-- Os campos titulos_superados_valor/qtd continuam no retorno, agora sempre
-- zerados, para não quebrar quem os lê.

create or replace function public.aluno_saldo_pendente_detalhe(
  p_aluno_id uuid,
  p_ignorar_confirmacao_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_titulos_abertos numeric := 0;
  v_titulos_orfaos  numeric := 0;
  v_parcelas_valor  numeric := 0;
  v_parcelas_qtd    int := 0;
  v_conf_pendentes  int := 0;
  v_total           numeric := 0;
  v_req_claims text := current_setting('request.jwt.claims', true);
  v_role       text := lower(coalesce(auth.jwt() ->> 'role', ''));
  v_uid        uuid := auth.uid();
  v_interno    boolean;
begin
  v_interno := (v_req_claims is null) or (v_role = 'service_role');
  if not v_interno then
    if v_uid is null or v_role = 'anon' then
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;
  end if;

  -- Mensalidade sai da conta SO quando vinculada a um acordo nao cancelado.
  -- Nada de deducao por data.
  select
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'ABERTO'), 0),
    coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'), 0)
    into v_titulos_abertos, v_titulos_orfaos
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  select count(*), coalesce(sum(coalesce(p.valor,0)),0)
    into v_parcelas_qtd, v_parcelas_valor
    from public.parcelas p
    join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = p_aluno_id
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select count(*)
    into v_conf_pendentes
    from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = p_aluno_id::text
     and s.status = 'AGUARDANDO_CONFIRMACAO'
     and (p_ignorar_confirmacao_id is null or s.id <> p_ignorar_confirmacao_id);

  v_total := v_titulos_abertos + v_titulos_orfaos + v_parcelas_valor;

  return jsonb_build_object(
    'aluno_id', p_aluno_id,
    'titulos_abertos', round(v_titulos_abertos, 2),
    'titulos_negociados_orfaos', round(v_titulos_orfaos, 2),
    -- Mantidos por compatibilidade; a deducao por data nao existe mais.
    'titulos_superados_valor', 0,
    'titulos_superados_qtd', 0,
    'parcelas_abertas_qtd', v_parcelas_qtd,
    'parcelas_abertas_valor', round(v_parcelas_valor, 2),
    'confirmacoes_pendentes', v_conf_pendentes,
    'confirmacao_ignorada', p_ignorar_confirmacao_id,
    'total', round(v_total, 2),
    'tem_pendencia', (v_total > 0.005 or v_conf_pendentes > 0)
  );
end;
$function$;

comment on function public.aluno_saldo_pendente_detalhe(uuid, uuid) is
  'Saldo pendente do aluno. Mensalidade so sai da conta quando VINCULADA a um acordo nao cancelado -- nao existe deducao por data.';
