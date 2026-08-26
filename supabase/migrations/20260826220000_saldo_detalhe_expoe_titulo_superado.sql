-- O card precisa dizer o que ele NÃO está contando.
--
-- Amanda, 26/08/2026, no caso da Lucrecia: "no card não aparece as
-- mensalidades dela" -- e depois "melhore a visualização dentro do financeiro
-- dos valores em aberto".
--
-- O QUE ACONTECIA. Existe uma regra chamada `titulo_superado_por_acordo`: se o
-- aluno fez um acordo DEPOIS do vencimento da mensalidade, o sistema assume que
-- aquela mensalidade entrou na negociação e para de somá-la. A regra é por
-- DATA, não por vínculo -- ninguém disse que aquela mensalidade pertence àquele
-- acordo, o sistema deduziu pelo calendário.
--
-- O problema não é a regra existir; é ela ser invisível. O card mostrava
-- "Mensalidades em aberto: R$ 0,00" enquanto a lista logo abaixo exibia três
-- mensalidades de R$ 197. Duas partes da mesma tela dizendo coisas diferentes,
-- e nenhuma pista de qual acreditar.
--
-- O TAMANHO: 1.460 alunos, 4.443 títulos, R$ 6.316.701,54 fora da conta.
--
-- O QUE ESTA MIGRATION FAZ: devolve `titulos_superados_valor` e
-- `titulos_superados_qtd`, para a tela poder MOSTRAR o que está deixando de
-- somar. `total` não muda em nada -- carteira, projeção e meta continuam
-- exatamente como estavam. Trazer esses R$ 6,3 milhões para dentro do saldo é
-- decisão de gente e fica para depois, com o número na mesa.
--
-- Conferido em produção: Lucrecia total 285,79 (inalterado) + 3 superadas de
-- R$ 591,00; Gemelli total 1.091,64 (inalterado) + 5 superadas de R$ 3.916,26.

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
  v_super_valor     numeric := 0;
  v_super_qtd       int := 0;
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
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  -- O MESMO filtro, invertido só na última linha: o que a regra de data tirou
  -- da conta. Fica fora do total; existe para a tela poder mostrar.
  select count(*),
         coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 0)
    into v_super_qtd, v_super_valor
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
     and public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

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
    'titulos_superados_valor', round(v_super_valor, 2),
    'titulos_superados_qtd', v_super_qtd,
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
  'Saldo pendente do aluno. Alem do total, devolve titulos_superados_valor/qtd: o que a regra titulo_superado_por_acordo (por DATA, nao por vinculo) tirou da conta. Esse valor NAO entra no total -- existe para a tela poder mostrar o que nao esta somando, em vez de exibir zero com a lista cheia logo abaixo.';
