-- Só fecha a confirmação quando o zero é de verdade.
--
-- O gatilho da migration anterior olhava só o `total` do saldo. Mas o total já
-- desconta as mensalidades que a regra `titulo_superado_por_acordo` escondeu --
-- aquelas que o sistema deduziu, PELA DATA, que entraram numa negociação.
--
-- Medido na fila antes de aplicar: dos 88 alunos com saldo zero, 12 só estavam
-- zerados por causa dessa dedução -- R$ 92.741,99 de mensalidade escondida.
-- Fechar a confirmação deles seria tirar da fila quem talvez ainda deva, com
-- base num palpite de calendário.
--
-- Agora exige as duas coisas: saldo zero E nenhuma mensalidade escondida pela
-- regra de data. Havendo escondida, a confirmação FICA na fila -- que é
-- exatamente onde alguém precisa olhar.
--
-- Sobraram 76 fechamentos legítimos, e esses são zero sem asterisco.

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
      where s.aluno_id = v_aluno::text and s.status = 'AGUARDANDO_CONFIRMACAO'
    ) then
      return null;
    end if;

    v_det := public.aluno_saldo_pendente_detalhe(v_aluno);

    -- Zero de verdade = não deve nada E não há mensalidade fora da conta por
    -- dedução de data.
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
     where s.aluno_id = v_aluno::text and s.status = 'AGUARDANDO_CONFIRMACAO';
  exception when others then
    return null;
  end;
  return null;
end;
$function$;

comment on function public._fechar_confirmacao_ao_zerar_saldo() is
  'Fecha as confirmacoes em aberto do aluno quando uma quitacao zera o saldo -- e so quando o zero e de verdade: exige tambem que nao haja mensalidade escondida pela regra titulo_superado_por_acordo (deducao por data). NAO quita ninguem e nao apaga divida. Engole qualquer erro para nunca derrubar a baixa que o disparou.';
