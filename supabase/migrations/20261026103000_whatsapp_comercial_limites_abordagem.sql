-- WHATSAPP COMERCIAL: LIMITES DE ABORDAGEM APROVADOS EM 26/10/2026.
--
-- LEIA ISTO ANTES DE APLICAR. Esta migration encerra, de forma deliberada, o
-- freio da fase de reaquecimento pos-ban. Nao e so ajuste de numero.
--
-- O QUE ELA MUDA:
--   whatsapp_config.teto_abordagens_operador        3 -> 8   (o FREIO DA FASE)
--   whatsapp_canais(comercial).limite_..._operador  2 -> 8
--   whatsapp_canais(comercial).limite_..._canal  NULL -> 30
--
-- POR QUE O TETO ENTRA AQUI, E NAO FOI IGNORADO. A trava criada em
-- 20260825140000 existe porque o canal Piloto (+55 51 99631-6324) foi BANIDO
-- pelo WhatsApp em 21/08/2026, depois de um lote de 10 abordagens a numeros
-- novos em 40 segundos -- e o numero era reincidente. O teto mora em
-- `whatsapp_config` justamente para que `whatsapp_canal_cadencia_salvar` NAO
-- consiga furar o limite por operador sem uma decisao explicita. Gravar 8 em
-- `limite_abordagens_operador` sem subir o teto deixaria o sistema incoerente:
-- a cadencia passaria a permitir 8, e a unica porta legitima de escrita
-- recusaria para sempre esse mesmo valor (42501 / TETO_ABORDAGENS_OPERADOR).
-- O comentario da coluna prescreve o caminho: "subir exige UPDATE deliberado
-- aqui". E o que esta migration faz, as claras.
--
-- O DESENHO ORIGINAL, ANTES DO BAN, era 10 por operador e 100 por canal
-- (docs/cadencia-por-canal.md). 8 e 30 ficam ABAIXO dos dois.
--
-- POR QUE 8 E 30. Medido em producao em 26/10/2026, somente o canal Comercial:
--   * por operador/dia (90 dias, 117 dias-operador): media 2,01, mediana 2,
--     P90 3, pico 16. O teto de 2 estava EM CIMA da mediana e barraria 59 das
--     235 abordagens do periodo (25,1%).
--   * por canal/dia (90 dias, 37 dias com abordagem): media 6,35, mediana 4,
--     P90 13, pico 38. 30 e 4,7x a media e 2,3x o P90.
--
-- O TETO DE CANAL E UM CONTROLE NOVO, NAO UMA FLEXIBILIZACAO. Hoje a coluna e
-- NULL, e NULL significa SEM LIMITE AGREGADO: o pico de 38 abordagens num dia
-- passou sem barreira nenhuma. Esta migration fecha esse buraco no mesmo passo
-- em que solta o limite individual.
--
-- RESSALVA QUE A GESTAO PRECISA TER LIDO. O indicador desenhado para decidir
-- este numero -- quantas vezes a equipe bateu no teto -- NUNCA produziu uma
-- linha: `whatsapp_cadencia_bloqueios` tem zero registros desde que existe,
-- porque o `.catch` encadeado na `whatsapp-send` estourava antes de a RPC de
-- log sair (corrigido na v18, publicada em 26/10/2026 09:55 BRT). Ou seja: esta
-- subida e decidida SEM a serie historica que o proprio desenho pedia. A
-- alternativa conservadora, registrada aqui para quem reabrir este arquivo, era
-- subir o operador so ate 3 (dentro do freio), aplicar o teto de canal, colher
-- 2 a 4 semanas de bloqueios reais com a v18 no ar e so entao decidir 8.
--
-- O QUE NAO MUDA, DE PROPOSITO:
--   * intervalo minimo de 60 s entre alunos distintos -- e a trava que responde
--     diretamente a causa do ban (10 abordagens em 40 s);
--   * janela de novas conversas 08:00-20:00;
--   * resposta a quem escreveu nas ultimas 24 h NAO consome cota: o caminho
--     RESPOSTA sai de `whatsapp_cadencia_checar` antes de qualquer contagem;
--   * modo do canal (ATIVO_CONTROLADO) e remetentes autorizados;
--   * Cobranca e Piloto: nenhuma coluna tocada.
--
-- ACOES MASSIVAS EXTERNAS FICAM FORA DISTO. Elas nao usam o gateway Comercial
-- como canal de disparo (confirmado pela operacao e corroborado pelo espelho:
-- em 06/10/2026, dia de 4.610 alunos exportados, o Baileys registrou 2 saidas
-- nesta linha). Nenhum limite daqui as governa, e nada aqui pretende governa-las.
--
-- ATOMICIDADE DO TETO DE CANAL, verificada no corpo de producao em 26/10/2026 e
-- NAO alterada aqui: `whatsapp_cadencia_checar` abre com
-- `select * from whatsapp_canais where id = p_canal_id FOR UPDATE` e so DEPOIS
-- insere em `whatsapp_abordagens` e conta. O lock de linha serializa todas as
-- checagens do mesmo canal, entao dois envios simultaneos nao leem a mesma
-- contagem e passam juntos. Ela e a UNICA funcao que escreve em
-- `whatsapp_abordagens`. As tres portas de entrada travam na mesma ordem --
-- conversas e depois canais --, entao nao ha ciclo de deadlock.
--
-- IDEMPOTENTE E FALHA FECHADO: aplica se o estado for o esperado (3/2/NULL) ou
-- o alvo (8/8/30). Qualquer outro valor significa que alguem mexeu depois desta
-- medicao, e a migration ABORTA em vez de sobrescrever decisao alheia.
--
-- APLICACAO: pendente de autorizacao. Rollback versionado ao lado.
do $$
declare
  v_teto      integer;
  v_op_atual  integer;
  v_ch_atual  integer;
  v_linhas    integer;
begin
  select teto_abordagens_operador into v_teto from public.whatsapp_config limit 1;
  if v_teto is null then
    raise exception 'whatsapp_config sem linha: nao ha teto para avaliar'
      using errcode = '42704';
  end if;

  select limite_abordagens_operador, limite_abordagens_canal
    into v_op_atual, v_ch_atual
    from public.whatsapp_canais
   where sessao_chave = 'comercial';

  if not found then
    raise exception 'canal comercial nao encontrado em whatsapp_canais'
      using errcode = '42704';
  end if;

  if v_teto = 8 and v_op_atual = 8 and v_ch_atual = 30 then
    raise notice 'teto 8, Comercial 8/30 - nada a fazer';
    return;
  end if;

  if v_teto is distinct from 3
     or v_op_atual is distinct from 2
     or v_ch_atual is not null then
    raise exception
      'estado inesperado: teto=% operador=% canal=% (esperado 3/2/NULL ou 8/8/30)',
      v_teto, coalesce(v_op_atual::text,'NULL'), coalesce(v_ch_atual::text,'NULL')
      using errcode = '22023';
  end if;

  -- 1. O freio da fase. Sem este passo, o limite gravado abaixo seria
  -- inalcancavel pela porta legitima de escrita.
  update public.whatsapp_config set teto_abordagens_operador = 8;
  get diagnostics v_linhas = row_count;
  if v_linhas <> 1 then
    raise exception 'esperava 1 linha em whatsapp_config, atualizou %', v_linhas
      using errcode = '22023';
  end if;

  -- 2. Os limites do canal. UPDATE direto em DUAS colunas: passar pela RPC
  -- exigiria reenviar modo e janela, e janela NULL apagaria a janela 08-20.
  update public.whatsapp_canais
     set limite_abordagens_operador = 8,
         limite_abordagens_canal    = 30
   where sessao_chave = 'comercial';
  get diagnostics v_linhas = row_count;
  if v_linhas <> 1 then
    raise exception 'esperava atualizar 1 canal, atualizou %', v_linhas
      using errcode = '22023';
  end if;

  raise notice 'teto 3 -> 8; Comercial: operador 2 -> 8, canal NULL -> 30';
end $$;
