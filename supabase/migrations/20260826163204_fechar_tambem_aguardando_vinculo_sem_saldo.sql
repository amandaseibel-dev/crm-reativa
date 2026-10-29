-- "Aguardando vínculo" também fecha quando não há dívida para vincular.
--
-- Amanda, 26/08/2026: "nathalia da silva novello nao esta saindo da fila".
--
-- O CASO DELA. Status QUITADO, saldo R$ 0,00, nada escondido. E três
-- solicitações do mesmo pagamento de R$ 1.502,71, de 24/08: uma confirmada e
-- duas em PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO.
--
-- A regra de fechamento automático que subiu hoje só olhava
-- AGUARDANDO_CONFIRMACAO. As duas dela estão no outro status e ficaram presas.
--
-- E "aguardando vínculo" é, nesse caso, uma exigência impossível: ele pede que
-- alguém aponte QUAL dívida aquele pagamento quitou -- só que não há dívida
-- nenhuma. O aluno não deve mais nada. Não há o que apontar.
--
-- Medido: 30 solicitações nesse status, 23 alunos. 13 deles já estavam sem
-- saldo algum -- presos pelo mesmo motivo da Nathalia. Os outros 10 ainda
-- devem, e para esses o "aguardando vínculo" está certo: existe dívida a
-- identificar.
--
-- A MUDANÇA: o gatilho passa a fechar os dois status, com a MESMA condição de
-- sempre -- saldo zero e nenhuma mensalidade escondida pela regra de data.
-- Continua não quitando ninguém e não apagando dívida.
--
-- Limpeza aplicada junto: 18 solicitações fechadas (de 30 para 12), incluindo
-- as duas da Nathalia.

create or replace function public._fechar_confirmacao_ao_zerar_saldo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_aluno uuid;
  v_det   jsonb;
begin
  begin
    if tg_table_name = 'parcelas' then
      select a.aluno_id into v_aluno from public.acordos a where a.id = new.acordo_id;
    else
      v_aluno := new.aluno_id;
    end if;
    if v_aluno is null then return null; end if;

    if not exists (
      select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = v_aluno::text
        and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
    ) then
      return null;
    end if;

    v_det := public.aluno_saldo_pendente_detalhe(v_aluno);

    if coalesce((v_det ->> 'total')::numeric, 1) > 0.005
       or coalesce((v_det ->> 'titulos_superados_valor')::numeric, 0) > 0.005 then
      return null;
    end if;

    update public.solicitacoes_confirmacao_pagamento s
       set status = 'PAGAMENTO_CONFIRMADO',
           observacao_adm = coalesce(nullif(btrim(s.observacao_adm), ''),
                                     'Fechada automaticamente: o aluno ficou sem saldo em aberto.'),
           confirmado_em = coalesce(s.confirmado_em, now()),
           atualizado_em = now()
     where s.aluno_id = v_aluno::text
       and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');

  exception when others then
    return null;
  end;
  return null;
end;
$function$;

comment on function public._fechar_confirmacao_ao_zerar_saldo() is
  'Fecha as solicitacoes em aberto do aluno -- AGUARDANDO_CONFIRMACAO e PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO -- quando uma quitacao zera o saldo, e so quando o zero e de verdade (sem mensalidade escondida pela regra de data). Aguardando vinculo sem divida e exigencia impossivel: nao ha o que apontar. NAO quita ninguem e nao apaga divida.';
