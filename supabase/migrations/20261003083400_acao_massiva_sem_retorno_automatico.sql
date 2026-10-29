-- ACAO MASSIVA: CONTA COMO ACIONAMENTO, MAS NAO PASSA PELA RECALCULADORA.
--
-- O QUE FOI MEDIDO EM PRODUCAO (03/10/2026, sobre os 2 primeiros lotes reais
-- da regra de 02/10 -- 200 alunos):
--   * 74 dos 200 ficaram com data_retorno = dia do registro + 10 e
--     status_acionamento = 'Acao massiva externa enviada -- aguardando retorno',
--     com retorno_origem = AUTOMATICO;
--   * os 74 tem, no dia, UMA unica movimentacao: ACAO_MASSIVA_EXTERNA do
--     proprio lote. Nenhuma movimentacao do fluxo Gmail (que tambem grava
--     retorno). A origem e, portanto, o proprio registro da acao massiva.
--
-- CAUSA. A migration 20261002094233 tirou o short-circuit dos tipos massivos
-- em fn_atualizar_ultimo_acionamento para a acao massiva voltar a contar como
-- ultimo acionamento. Com isso reabriu tambem a ULTIMA linha do gatilho:
--   perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
-- A recalculadora escreve data_retorno (8 ocorrencias) e status_acionamento.
-- Entre 20/09 e 02/10 ela nunca era chamada para acao massiva, porque o
-- gatilho saia antes.
--
-- A CORRECAO, MINIMA. O gatilho deixa de chamar a recalculadora para
-- ACAO_MASSIVA_EXTERNA / ACAO_MASSIVA_EXTERNA_EMAIL. Nada mais muda:
--   * acao massiva CONTINUA contando como ultimo acionamento do aluno e do
--     caso (os dois updates acima seguem valendo), logo a fidelizacao de 10
--     dias e o "nunca acionado" seguem como a gestao decidiu em 02/10;
--   * acao massiva volta a NAO criar data_retorno, NAO gravar
--     status_acionamento, NAO trocar responsavel;
--   * contato de operador e todos os demais tipos seguem chamando a
--     recalculadora exatamente como hoje.
--
-- POR QUE NAO MEXER NA RECALCULADORA. recalcular_situacao_aluno tem 13.696
-- caracteres, assinatura (p_aluno_id uuid, p_lote text) -- nao existe
-- parametro de motivo para ramificar -- e e chamada por outras funcoes
-- (limpar_mensalidade_principal_pago, prime_conferencia_rejeitar,
-- acordo_avista...). Qualquer corte dentro dela atingiria esses chamadores.
-- Nao e tocada aqui.
--
-- RISCO ACEITO, DECLARADO. Para acao massiva, situacao/criticidade nao sao
-- recalculadas no instante do registro. E exatamente o estado que rodou em
-- producao entre 20/09 e 02/10. Os indicadores que a gestao usa para
-- fidelizacao e "nunca acionado" leem data_ultimo_acionamento, que continua
-- sendo atualizado.
--
-- NAO MEXE nos 74 registros ja afetados: esta migration nao escreve em alunos,
-- casos, movimentacoes nem em nada financeiro. So redefine o gatilho.

create or replace function public.fn_atualizar_ultimo_acionamento()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  -- SO AVANCA: um acionamento mais antigo nunca sobrescreve um mais novo.
  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = new.registrado_em::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < new.registrado_em::date);

  -- Acao massiva NAO passa pela recalculadora: ela escreve data_retorno e
  -- status_acionamento, e a campanha nao pode criar retorno nem tabular.
  -- Contato de operador e os demais tipos seguem recalculando como sempre.
  if new.tipo not in ('ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL') then
    begin
      perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
    exception when others then
      null;
    end;
  end if;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$function$;
