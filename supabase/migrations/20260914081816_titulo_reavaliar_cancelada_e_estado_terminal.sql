-- TITULO CANCELADO E ESTADO TERMINAL PARA A REAVALIACAO AUTOMATICA.
--
-- O QUE ESTAVA ERRADO. `titulo_reavaliar` para cedo em dois casos -- titulo
-- PAGO e titulo com status 'quitada'/'paga'. Fora deles, quando o titulo nao
-- tem acordo vivo, ela devolve o titulo para ABERTO/em_aberto. `CANCELADA`
-- nunca entrou nessa lista de parada. Resultado: um titulo cancelado voltava a
-- ser divida cobravel sozinho, na proxima vez que a funcao fosse chamada.
--
-- QUEM CHAMA (producao, 13/09/2026):
--   trg_acordo_status_reavalia_titulos  -> AFTER UPDATE OF status ON acordos
--   trg_titulo_situacao_por_vinculo     -> AFTER INS/UPD/DEL ON acordo_titulo_vinculo
--   fluxo_acordos_rodar                 -> rotina (cron fluxo_acordos_diario, hoje inativo)
-- Ou seja: basta o status de um acordo mudar, ou alguem mexer num vinculo, para
-- a reavaliacao passar por todo titulo daquele acordo -- inclusive os que ja
-- tinham sido cancelados de proposito por `trg_titulos_por_status_acordo`.
--
-- POR QUE ISSO IMPORTA AGORA. Desde 31/08 existe a regra que cancela o boleto
-- do proprio acordo quando o acordo e cancelado (migration
-- 20260831170746_excluir_titulo_que_nao_existe, "boleto do proprio acordo,
-- cancelado junto com o acordo"). Essa regra ainda nao rodou nenhuma vez em
-- producao. Quando rodar, sem esta guarda o proprio sistema desfaria o
-- cancelamento na proxima reavaliacao, e a dobra voltaria.
--
-- CHECAGEM FEITA ANTES DE ESCREVER (13/09/2026, somente leitura):
--   - 262 titulos estao hoje em CANCELADA/cancelada (R$ 2.399.695,89);
--   - em todo o `audit_log` ha 274 transicoes ENTRANDO em CANCELADA e
--     ZERO transicoes SAINDO. 274 - 12 excluidos = os 262 atuais;
--   - nao existe fluxo de "desfazer cancelamento de titulo": `desfazer_acao` so
--     trata TERMO/LINK, `titulo_desfazer_duplicada` exige situacao='DUPLICADA',
--     e a ficha nao oferece desfazer para acordo CANCELADO (comentario em
--     FinanceiroAluno.jsx: "o QUITADO mantem o Desfazer. O CANCELADO nao").
--   Nenhum fluxo legitimo depende de `titulo_reavaliar` reabrir um CANCELADA.
--
-- VOCABULARIO REAL DA TABELA (medido, nao inventado): a unica combinacao
-- cancelada existente em `acordos_titulos` e `CANCELADA` / `cancelada`, nas
-- 262 linhas. O gatilho `_titulo_situacao_e_status_coerentes` ja forca
-- `status='cancelada'` sempre que `situacao='CANCELADA'`. Por isso a guarda
-- testa exatamente esses dois valores, e nenhum outro. Precedente no proprio
-- banco: `quitar_e_encerrar_caso` e a lista de bloqueio de
-- `vincular_titulos_acordo` ja tratam 'cancelada' como terminal.
--
-- O QUE ESTA MIGRATION FAZ: acrescenta uma segunda parada antecipada, logo
-- depois da parada de PAGO/quitada. Nada mais. O corpo restante e byte a byte
-- o mesmo de `pg_get_functiondef` em producao em 13/09/2026
-- (md5 17abaf4f192c127be95647ca86a472e3, 2796 bytes), guardado em
-- supabase/audits/titulo_reavaliar_producao_20260913.sql -- a funcao nao tinha
-- nenhuma definicao no repositorio, so em producao.
--
-- O QUE ELA NAO FAZ: nao altera nenhum titulo existente, nao faz backfill, nao
-- muda saldo, nao cria nem apaga estado, nao mexe em trg_titulos_por_status_acordo,
-- acordo_cancelar, cancelar_acordo_ficha, vincular_titulos_acordo, Santander,
-- Prime, pagamentos ou crons. Nao ha DML aqui: e so um CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.titulo_reavaliar(p_titulo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_situacao text; v_status text;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
begin
  select situacao, status into v_situacao, v_status
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  -- Ja cancelada: nada aqui ressuscita titulo cancelado. Cancelar e uma decisao
  -- deliberada (rotina ou gestao); a reavaliacao automatica nao desfaz decisao.
  -- Voltar a cobrar exige um caminho explicito, que hoje nao existe -- e quando
  -- existir sera um "desfazer" com registro, nao um efeito colateral daqui.
  if upper(coalesce(v_situacao,'')) = 'CANCELADA'
     or lower(coalesce(v_status,'')) = 'cancelada' then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  -- Sem acordo vivo: a divida volta a ser cobrada. O vinculo continua na
  -- tabela, entao a composicao do acordo nao se perde -- ver a tela do acordo.
  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
  -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
  -- RENEGOCIADA nao entra aqui: parcela renegociada nao e parcela paga.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$function$;

comment on function public.titulo_reavaliar(uuid) is
  'Reavalia um titulo contra o acordo vivo dele. PAGO/quitada e CANCELADA/cancelada sao estados terminais: a reavaliacao automatica nunca os reabre.';
