-- MENSALIDADE NEGOCIADA NAO VOLTA A SER ABERTA SO PORQUE O ACORDO FOI CANCELADO.
--
-- REGRA DE NEGOCIO (Amanda, 22/09/2026): quando uma mensalidade original foi
-- usada numa negociacao e passou para NEGOCIADO, ela nao deve voltar
-- automaticamente para ABERTO/VENCIDO/INADIMPLENTE so porque o acordo que a
-- continha foi CANCELADO, QUEBRADO ou ficou INATIVO. Cancelar o acordo muda o
-- ESTADO DO ACORDO; nao desfaz retroativamente a negociacao da mensalidade.
-- A mensalidade continua NEGOCIADA no historico; o vinculo com o acordo
-- cancelado nunca e apagado, so desativado.
--
-- Isso REVERTE a decisao tomada em 09/09/2026 (titulo_reavaliar, ver comentario
-- "Sem acordo vivo: a divida volta a ser cobrada" e
-- acordo-cancelado-devolve-mensalidade na memoria operacional), que tratava
-- "sem vinculo ativo com acordo nao-cancelado" como "a divida volta a ser
-- cobrada" sem distinguir a causa. A Amanda decidiu explicitamente reverter
-- essa regra: cancelamento de acordo deixou de ser gatilho de reabertura.
--
-- AUDITORIA SOMENTE LEITURA FEITA ANTES DE ESCREVER (22/09/2026, em producao):
-- tres pontos escrevem essa reabertura, e os tres mudam juntos nesta migration
-- (senao um desfaz o outro):
--
--   1. titulo_reavaliar(uuid) -- funcao central, chamada por dois gatilhos
--      (trg_acordo_status_reavalia_titulos em acordos, trg_titulo_situacao_por_vinculo
--      em acordo_titulo_vinculo). Quando nao acha vinculo ATIVO com acordo que
--      nao esteja CANCELADO/CANCELADA, reabre para ABERTO sem checar a causa.
--
--   2. titulos_por_status_acordo() -- gatilho DUPLICADO e mais direto
--      (trg_titulos_por_status_acordo, tambem AFTER UPDATE OF status ON acordos,
--      rodando em paralelo ao #1). Tinha uma branch explicita "a MENSALIDADE
--      volta a ser cobravel: o acordo que a substituia caiu" que reabria
--      NEGOCIADO->ABERTO na marra quando acordo.status='CANCELADO'. Hoje ela
--      normalmente nao faz nada porque a ordem alfabetica dos gatilhos poe o
--      #1 pra rodar primeiro (que ja deixa o titulo ABERTO) -- mas corrigir so
--      o #1 e deixar o #2 de pe faria o #2 desfazer a correcao sozinho.
--
--   3. cancelar_acordo_ficha(uuid) -- a RPC de fato usada pela tela (botao
--      "Cancelar acordo" em FinanceiroAluno.jsx). Ela APAGAVA (DELETE) as
--      linhas de acordo_titulo_vinculo em vez de so desativar -- isso destruia
--      a cadeia historica mensalidade->negociacao->acordo, e era o que fazia
--      o #1 cair no caminho "sem vinculo nenhum" (reabre). Passa a desativar
--      (ativo=false), como acordo_cancelar() ja fazia.
--
-- NAO ENCONTRADO (demais itens do checklist pedido, conferidos em producao):
--   - nenhuma funcao prime_* escreve situacao de titulo a partir do status do
--     acordo (sync Prime/API nao participa);
--   - nenhum dos 38 jobs de cron.job chama, direta ou indiretamente por outro
--     caminho, uma funcao que grava ABERTO/VENCIDO/INADIMPLENTE nesse contexto
--     alem dos gatilhos #1/#2 acima;
--   - acoes massivas, efetividade, dashboards (saude_carteira_*), filas de
--     cobranca, calculo de saldo e reconciliacao so LEEM NEGOCIADO/CANCELADO
--     em filtros -- corrigindo #1 e #2, essas telas refletem certo sozinhas;
--   - existe uma segunda funcao de cancelamento, acordo_cancelar(uuid,motivo),
--     que ja desativava o vinculo (nao apagava) -- mas nao tem NENHUM caller no
--     repositorio (grep em src/, supabase/functions/, services/): e codigo
--     morto. Nao precisou mudar; o comportamento dela ja segue #1 corrigido.
--   - desvincular_titulos_acordo(uuid[]) tambem reabre para ABERTO e apaga o
--     vinculo, mas e acao MANUAL da gestao (nao e disparada pelo status do
--     acordo) -- fora do escopo desta regra.
--
-- ACHADO SEPARADO, CONSERTADO DE BONUS (nao era o pedido, mas e consequencia
-- direta da correcao -- ver o comentario dentro de cancelar_acordo_ficha):
-- "boleto do proprio acordo, cancelado junto com o acordo", dentro de
-- titulos_por_status_acordo, dependia de acordo_titulo_vinculo.ativo=true no
-- momento em que acordos.status muda para CANCELADO. cancelar_acordo_ficha
-- desativava o vinculo ANTES de atualizar o status do acordo, entao esse
-- branch nunca disparava por esse caminho. A reordenacao que corrige a
-- reabertura da mensalidade (acordos.status muda primeiro) tambem faz esse
-- branch funcionar. Boleto do proprio acordo nunca foi divida -- e so o
-- numero do documento -- entao isso nao mexe em saldo nenhum.
--
-- MEDICAO DOS DADOS JA INCORRETOS (via audit_log, 22/09/2026, somente leitura):
-- 295 titulos / 111 alunos / 112 acordos cancelados tiveram a transicao
-- NEGOCIADO->ABERTO/VENCIDO causada por um acordo hoje CANCELADO. Valor
-- original R$ 636.128,04; saldo em aberto hoje R$ 81.040,32, sendo 133 titulos
-- ainda ABERTO (65 alunos, 65 acordos, R$ 79.381,07 -- exposicao viva agora),
-- 83 desses 133 sem NENHUMA linha de acordo_titulo_vinculo (o vinculo foi
-- apagado pelo cancelar_acordo_ficha antigo); os outros 50 ainda tem o
-- vinculo, so inativo. O saneamento desses registros e uma decisao separada,
-- apresentada a parte -- esta migration so muda o comportamento DAQUI PRA
-- FRENTE.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao faz backfill nem corrige nenhum titulo
-- existente, nao mexe em confirmacao de pagamento, baixa, D-2 ou vinculacao de
-- pagamentos, nao mexe em acordo_cancelar (ja estava certa), nao mexe em
-- desvincular_titulos_acordo (acao manual, fora do escopo), nao muda RLS nem
-- ACL. Os tres corpos abaixo partem, byte a byte, do que estava em producao em
-- 22/09/2026 -- ver supabase/audits/acordo_cancelado_nao_reabre_mensalidade_producao_20260922.sql.

-- ---------------------------------------------------------------------------
-- 1) titulo_reavaliar: nova parada antecipada entre o calculo do acordo vivo
--    e o "sem acordo vivo, reabre". So entra quando o titulo JA esta NEGOCIADO
--    (se nunca foi negociado, o comportamento de reabrir continua igual) e o
--    acordo mais recente ligado a ele -- pelo vinculo mais recente (ativo ou
--    nao) ou, se o vinculo ja foi apagado por algum caminho antigo, pelo
--    acordo_id que o proprio titulo ainda guarda -- esta CANCELADO, CANCELADA,
--    QUEBRADO ou INATIVO.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.titulo_reavaliar(p_titulo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_situacao text; v_status text; v_acordo_atual uuid;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
  v_acordo_bloqueio uuid; v_status_bloqueio text;
begin
  select situacao, status, acordo_id into v_situacao, v_status, v_acordo_atual
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

  -- Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/QUEBRADO/INATIVO): o
  -- cancelamento e uma mudanca de estado do ACORDO, nao uma decisao sobre a
  -- mensalidade original. A negociacao fica preservada no historico -- a
  -- reavaliacao automatica nao desfaz retroativamente o que foi negociado, nem
  -- soma de novo o valor como mensalidade em aberto. So entra aqui quando a
  -- situacao ATUAL do titulo ja e NEGOCIADO: se nunca foi negociado, ou se o
  -- motivo de nao achar vinculo vivo e outro, o caminho de baixo decide, como
  -- sempre decidiu.
  if v_acordo is null and upper(coalesce(v_situacao,'')) = 'NEGOCIADO' then
    select coalesce(
        (select v.acordo_id from public.acordo_titulo_vinculo v
          where v.titulo_id = p_titulo
          order by v.criado_em desc nulls last limit 1),
        v_acordo_atual)
      into v_acordo_bloqueio;

    if v_acordo_bloqueio is not null then
      select upper(coalesce(status,'')) into v_status_bloqueio
        from public.acordos where id = v_acordo_bloqueio;
    end if;

    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO') then
      return;
    end if;
  end if;

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
  'Reavalia um titulo contra o acordo vivo dele. PAGO/quitada e CANCELADA/cancelada sao estados terminais. Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/CANCELADA/QUEBRADO/INATIVO) tambem nao e reaberta: fica NEGOCIADA no historico (regra de 22/09/2026, reverte a de 09/09).';

-- ---------------------------------------------------------------------------
-- 2) titulos_por_status_acordo: remove a branch que reabria NEGOCIADO->ABERTO
--    quando acordo.status vira CANCELADO. Mantem intacto o resto: a quitacao
--    junto com o acordo (QUITADO) e o cancelamento do boleto do proprio
--    acordo (que nunca foi divida -- e so o numero do documento).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.titulos_por_status_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'QUITADO' then
    update public.acordos_titulos t set situacao = 'PAGO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('ABERTO','NEGOCIADO');

  elsif new.status = 'CANCELADO' then
    -- A MENSALIDADE NEGOCIADA NAO VOLTA A SER ABERTA AQUI (branch removida em
    -- 22/09/2026): cancelar o acordo muda o estado do ACORDO, nao desfaz
    -- retroativamente a negociacao das mensalidades originais. Quem decide o
    -- destino do titulo e titulo_reavaliar, chamado pelo outro gatilho desta
    -- mesma tabela (trg_acordo_status_reavalia_titulos) -- ele preserva
    -- NEGOCIADO quando o motivo e so o acordo ter caido.

    -- o BOLETO DO PROPRIO ACORDO morre junto com ele, tendo mensalidade
    -- vinculada ou nao. Ele nunca foi divida: e o numero do documento.
    update public.acordos_titulos t
       set situacao = 'CANCELADA',
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'boleto do proprio acordo, cancelado junto com o acordo em '
             || to_char(now(),'DD/MM/YYYY'),
           atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('NEGOCIADO','ABERTO')
       and coalesce(t.tipo_boleto,'') = 'Acordo';
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) cancelar_acordo_ficha: desativa o vinculo (ativo=false) em vez de
--    apagar (DELETE), preservando a cadeia mensalidade->negociacao->acordo.
--    Remove o UPDATE que tentava gravar status='em_aberto' direto no titulo --
--    hoje ele ja e neutralizado pelo gatilho de coerencia
--    (_titulo_situacao_e_status_coerentes forca status de volta a 'vinculada'
--    quando situacao continua NEGOCIADO), entao era so codigo morto e
--    contraditorio com a regra nova; o retorno da funcao para de anunciar
--    "titulos_reabertos" porque, de proposito, nenhum titulo e mais reaberto
--    por aqui.
--
--    ORDEM IMPORTA (achado nos testes de comportamento, PGlite): o UPDATE em
--    acordos.status tem que rodar ANTES do UPDATE em acordo_titulo_vinculo.
--    O gatilho do vinculo (trg_titulo_situacao_por_vinculo) chama
--    titulo_reavaliar no MOMENTO em que ativo vira false; se o acordo ainda
--    estivesse ATIVO nesse instante, a guarda nova de titulo_reavaliar nao
--    acharia motivo pra bloquear (o acordo bloqueado tem que estar
--    CANCELADO/CANCELADA/QUEBRADO/INATIVO NA HORA em que ela olha) e o titulo
--    reabriria ali mesmo, antes do proprio UPDATE de status rodar. Cancelar o
--    acordo primeiro faz o gatilho de status (trg_acordo_status_reavalia_titulos)
--    rodar primeiro, ja com o acordo CANCELADO -- e essa ordem, de bonus,
--    tambem faz o cancelamento do boleto do proprio acordo (dentro de
--    titulos_por_status_acordo) funcionar por este caminho pela primeira vez:
--    antes, o vinculo ja estava apagado quando o status mudava, entao aquele
--    branch nunca achava a linha. Boleto do proprio acordo nunca foi divida
--    (e so o numero do documento), entao isso nao mexe em saldo nenhum.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancelar_acordo_ficha(p_acordo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_agora    timestamptz := now();
  v_acordo   public.acordos%rowtype;
  v_vinculos int := 0;
  v_parcelas int := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Cancelar acordo e exclusivo da gestao financeira.' using errcode = '42501';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo ja esta cancelado.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.parcelas where acordo_id = p_acordo_id and upper(coalesce(status, '')) = 'PAGO') then
    raise exception 'Esse acordo ja tem parcela paga -- nao da pra cancelar (protege o historico financeiro). Se foi um erro, fale com quem confirmou o pagamento antes de mexer.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.baixas_pagamento where acordo_id = p_acordo_id and devolvido_em is null) then
    raise exception 'Esse acordo ja tem alguma baixa/pagamento registrado -- nao da pra cancelar por aqui.' using errcode = 'P0001';
  end if;

  -- As mensalidades negociadas NAO voltam para ABERTO aqui: cancelar o acordo
  -- muda o estado do ACORDO, nao desfaz a negociacao das mensalidades
  -- originais. Por isso o status do acordo muda PRIMEIRO -- e' o gatilho desse
  -- UPDATE (trg_acordo_status_reavalia_titulos -> titulo_reavaliar) que decide
  -- o destino de cada titulo, e ele precisa ver o acordo ja CANCELADO. So
  -- depois o vinculo e' desativado -- nunca apagado -- para a cadeia
  -- mensalidade->negociacao->acordo continuar inteira na tela e na auditoria.
  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = v_agora
   where id = p_acordo_id;

  update public.acordo_titulo_vinculo
     set ativo = false
   where acordo_id = p_acordo_id and coalesce(ativo, true);
  get diagnostics v_vinculos = row_count;

  update public.parcelas
     set status = 'CANCELADA', atualizado_em = v_agora
   where acordo_id = p_acordo_id
     and upper(coalesce(status, '')) <> 'PAGO';
  get diagnostics v_parcelas = row_count;

  if v_acordo.aluno_id is not null then
    perform public.liberar_caso_por_evento(v_acordo.aluno_id, 'CANCELADO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', p_acordo_id,
    'vinculos_desativados', v_vinculos,
    'parcelas_canceladas', v_parcelas
  );
end;
$function$;
