-- ============================================================================
-- ULBRA — PAINEL GESTAO DA MENSAGERIA: agregacao no banco, so para a gestao
--
-- Artefato de 09/11/2026. NAO APLICAR SEM AUTORIZACAO EXPLICITA DA GESTAO.
-- Apresentada SEPARADAMENTE da migration do piloto (20261108140000, ja
-- aplicada como 20261108204402). Esta aqui NAO esta coberta por nenhuma linha
-- M1 existente: precisa de linha propria.
--
-- O QUE ISTO INSTALA
--   1 funcao: public.ulbra_painel_gestao() -> jsonb
--
-- POR QUE UMA FUNCAO, E NAO A TELA SOMANDO LINHAS
--   O sino le ate 200 linhas e conta na tela. Um painel gerencial nao pode
--   herdar esse teto: os indicadores saem de agregacoes feitas AQUI, sobre o
--   espelho inteiro (`count`, `group by`, `percentile_cont`), e a tela recebe
--   so os numeros. Zero linha de dado pessoal sai desta funcao: nenhum nome,
--   telefone, previa de mensagem ou id de cliente -- so contagens, datas e
--   e-mails de operador (que ja sao visiveis a gestao em `casos`).
--
-- O QUE ISTO NAO FAZ
--   - nao chama a ULBRA. Le so o Postgres;
--   - nao calcula divergencia de responsavel por nome (depende do mapeamento
--     20261108150000, nao aplicado) -- o campo sai como null = "nao disponivel";
--   - nao cria cron, nao altera tabela, policy ou grant existente.
--
-- SEGURANCA
--   security definer com search_path fixo, porque le `cron.job` (so para
--   dizer se a atualizacao e automatica ou manual) e porque a agregacao nao
--   deve depender de a RLS filtrar certo para cada perfil: o portao e EXPLICITO
--   na primeira linha -- quem nao e gestao recebe ACESSO_NEGADO e nenhum
--   numero. REVOKE de public/anon; EXECUTE so para authenticated (o portao
--   interno e quem restringe a gestao -- memoria
--   `restringir-a-gestao-e-portao-interno-nunca-revoke-de-authenticated`).
-- ============================================================================

begin;

create or replace function public.ulbra_painel_gestao()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email        text := lower(coalesce(app_email(), ''));
  v_estado       public.ulbra_sync_estado;
  v_atraso_min   numeric;
  v_atualizacao  text := 'desconhecida';
  v_cron_ativo   boolean;
  v_estado_painel text;
  v_conversas    jsonb;
  v_atend        jsonb;
  v_espera       jsonb;
  v_cobertura    jsonb;
  -- Limiar de "desatualizado" quando ha cron: 2 intervalos nominais de 10 min
  -- mais folga. So vale com atualizacao AUTOMATICA -- sem cron, atraso nao e
  -- defeito, e informacao ("atualizacao manual, ultimo ciclo ha N min").
  c_limiar_desatualizado_min constant numeric := 25;
begin
  -- ------------------------------------------------------------- portao
  if v_email = '' or not app_usuario_ativo() or eh_painel() or not usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'motivo', 'ACESSO_NEGADO');
  end if;

  -- ------------------------------------------------------- estado do ciclo
  select * into v_estado from public.ulbra_sync_estado where id;
  if v_estado.ultima_execucao is not null then
    v_atraso_min := round(extract(epoch from (now() - v_estado.ultima_execucao)) / 60.0);
  end if;

  -- Ha cron? Em ambiente sem pg_cron (teste), fica 'desconhecida', nunca inventa.
  begin
    if to_regclass('cron.job') is not null then
      execute 'select exists (select 1 from cron.job where jobname = $1 and active)'
        into v_cron_ativo using 'ulbra_sincronizar';
      v_atualizacao := case when v_cron_ativo then 'automatica' else 'manual' end;
    end if;
  exception when others then
    v_atualizacao := 'desconhecida';
  end;

  -- Os valores de `ultimo_ciclo` sao os que a funcao grava: OK, INCOMPLETO,
  -- FALHOU, PULADO_ORCAMENTO. Cada um e um estado proprio:
  --   PULADO_ORCAMENTO nunca e "atualizado": nada foi lido, os numeros sao do
  --   ciclo anterior. EM_DIA so existe com atualizacao AUTOMATICA; na manual,
  --   o estado e COLETA_CONCLUIDA -- a tela diz "ultima coleta concluida em
  --   <data e hora>", sempre com a hora, porque nao ha relogio prometendo a
  --   proxima.
  v_estado_painel := case
    when v_estado.ultima_execucao is null then 'SEM_CICLO'
    when v_estado.ultimo_ciclo = 'FALHOU' then 'ERRO'
    when v_estado.ultimo_ciclo = 'PULADO_ORCAMENTO' then 'PULADO_ORCAMENTO'
    when v_atualizacao = 'automatica' and v_atraso_min > c_limiar_desatualizado_min then 'DESATUALIZADO'
    when v_estado.ultimo_ciclo = 'INCOMPLETO' then 'INCOMPLETO'
    when v_atualizacao = 'automatica' then 'EM_DIA'
    else 'COLETA_CONCLUIDA'
  end;

  -- ------------------------------------------------------------ conversas
  -- "resposta aguardando" = a ULTIMA mensagem da conversa e do cliente.
  -- "nao lida para mim" = ha mensagem do cliente mais nova do que ate onde
  -- EU (quem chama) li -- a mesma regra do sino, por usuario, nunca global.
  with c as (
    select *,
      (ultima_mensagem_quem = 'cliente') as resposta_aguardando,
      (ultima_mensagem_cliente_em is not null and not exists (
         select 1 from public.ulbra_leitura_usuario l
          where l.ulbra_conversa_id = ulbra_conversas.ulbra_conversa_id
            and l.usuario_email = v_email
            and l.lido_ate >= ulbra_conversas.ultima_mensagem_cliente_em)) as nao_lida_para_mim
    from public.ulbra_conversas
  )
  select jsonb_build_object(
    'total', count(*),
    'por_canal', coalesce((select jsonb_object_agg(canal, n) from (select canal, count(*) n from c group by canal) t), '{}'::jsonb),
    'por_situacao', coalesce((select jsonb_object_agg(situacao, n) from (select situacao, count(*) n from c group by situacao) t), '{}'::jsonb),
    'identidade_confirmada', count(*) filter (where aluno_status = 'vinculado'),
    'identidade_nao_confirmada', count(*) filter (where aluno_status <> 'vinculado'),
    'resposta_aguardando', count(*) filter (where resposta_aguardando),
    'nao_lidas_para_mim', count(*) filter (where nao_lida_para_mim),
    -- ATENDENTE NA MENSAGERIA (lado ULBRA), como a propria Mensageria informa em
    -- `responsavel_ulbra`. E dado do outro sistema, nao posse no ReATIVA: nunca
    -- se mistura com `responsavel_email` dos atendimentos. Sai pelo valor bruto;
    -- nenhum casamento por nome e feito aqui.
    'com_atendente_ulbra', count(*) filter (where responsavel_ulbra is not null),
    'sem_atendente_ulbra', count(*) filter (where responsavel_ulbra is null),
    'por_atendente_ulbra', coalesce((select jsonb_object_agg(responsavel_ulbra, n) from (select responsavel_ulbra, count(*) n from c where responsavel_ulbra is not null group by responsavel_ulbra) t), '{}'::jsonb),
    -- espera de RESPOSTA: comeca na ultima mensagem do cliente
    'resposta_mais_antiga_em', min(ultima_mensagem_cliente_em) filter (where resposta_aguardando),
    'espera_resposta_max_min', case when count(*) filter (where resposta_aguardando) = 0 then null
      else round(extract(epoch from (now() - min(ultima_mensagem_cliente_em) filter (where resposta_aguardando))) / 60.0) end
  ) into v_conversas from c;

  -- --------------------------------------------------------- atendimentos
  -- DOIS LADOS QUE NAO SE MISTURAM:
  --   * RESPONSAVEL NO REATIVA = `responsavel_email`: quem ASSUMIU aqui, por
  --     UPDATE condicional. `null` prova so que ninguem assumiu NO REATIVA.
  --   * ATENDENTE NA MENSAGERIA = quem atende do lado da ULBRA. O espelho de
  --     atendimentos NAO guarda esse campo (a sincronizacao nao o le), entao
  --     ele sai como null = "nao disponivel". `responsavel_email` vazio NUNCA
  --     e usado como prova de que o atendimento esta sem atendente na ULBRA.
  -- "Distribuicao por responsavel" = posse comprovada no ReATIVA; a sugestao de
  -- destino sai a parte, rotulada como sugestao.
  with a as (
    select * from public.ulbra_atendimentos where dispensado_em is null
  )
  select jsonb_build_object(
    'coletados', count(*),
    'sem_responsavel_reativa', count(*) filter (where responsavel_email is null),
    'com_responsavel_reativa', count(*) filter (where responsavel_email is not null),
    'por_responsavel_reativa', coalesce((select jsonb_object_agg(responsavel_email, n) from (select responsavel_email, count(*) n from a where responsavel_email is not null group by responsavel_email) t), '{}'::jsonb),
    -- lado ULBRA: o espelho de atendimentos nao guarda o atendente
    'atendente_ulbra', null,
    'em_conferencia', count(*) filter (where destino_motivo = 'CONFERENCIA'),
    'sem_operador', count(*) filter (where destino_motivo = 'SEM_OPERADOR'),
    'por_situacao', coalesce((select jsonb_object_agg(situacao, n) from (select situacao, count(*) n from a group by situacao) t), '{}'::jsonb),
    'por_destino_sugerido', coalesce((select jsonb_object_agg(destino_motivo, n) from (select destino_motivo, count(*) n from a group by destino_motivo) t), '{}'::jsonb),
    -- a tabela de atendimentos NAO tem canal: nao inventar
    'por_canal', null,
    -- divergencia carteira x atendente ULBRA: so com o mapeamento (nao aplicado)
    'divergencia_carteira_ulbra', null
  ) into v_atend from a;

  -- --------------------------------------------------------------- espera
  -- Espera dos atendimentos SEM RESPONSAVEL NO REATIVA (ninguem assumiu aqui).
  -- A CONTAGEM COMECA EM `entrou_em`: a hora em que o atendimento entrou em
  -- espera NA MENSAGERIA, informada pela ULBRA -- nao a hora em que o espelho
  -- o coletou. Sem `entrou_em`, o atendimento nao entra na conta e e contado
  -- em `sem_data`, para a gestao saber que esta de fora.
  with e as (
    select extract(epoch from (now() - entrou_em)) / 60.0 as min
      from public.ulbra_atendimentos
     where dispensado_em is null and responsavel_email is null and entrou_em is not null
  )
  select jsonb_build_object(
    'base', 'entrou_em (entrada em espera na Mensageria, informada pela ULBRA)',
    'universo', 'atendimentos sem responsavel NO REATIVA (ninguem assumiu aqui); nao diz nada sobre atendente na ULBRA',
    'n', count(*),
    'sem_data', (select count(*) from public.ulbra_atendimentos
                  where dispensado_em is null and responsavel_email is null and entrou_em is null),
    'max_min', case when count(*) = 0 then null else round(max(min)) end,
    'mediana_min', case when count(*) = 0 then null else round(percentile_cont(0.5) within group (order by min)::numeric) end,
    'acima_30_min', count(*) filter (where min > 30)
  ) into v_espera from e;

  -- ------------------------------------------------------------ cobertura
  -- O espelho e PARCIAL por construcao (equipe Reativa, situacao active, 1
  -- canal, N paginas). Isto diz o que foi coletado; nunca "o total da
  -- Mensageria". Alcance em paginas nao e gravado hoje: null = nao disponivel.
  select jsonb_build_object(
    'equipe', 'Reativa',
    'canais_coletados', coalesce((select jsonb_agg(distinct canal) from public.ulbra_conversas), '[]'::jsonb),
    'situacoes_coletadas', coalesce((select jsonb_agg(distinct situacao) from public.ulbra_conversas), '[]'::jsonb),
    'periodo', jsonb_build_object(
      'conversas_de',    (select min(ultima_mensagem_em) from public.ulbra_conversas),
      'conversas_ate',   (select max(ultima_mensagem_em) from public.ulbra_conversas),
      'atendimentos_de', (select min(entrou_em) from public.ulbra_atendimentos),
      'atendimentos_ate',(select max(entrou_em) from public.ulbra_atendimentos),
      'primeira_coleta', (select min(criado_em) from public.ulbra_conversas),
      'ultima_coleta',   v_estado.ultima_execucao
    ),
    'alcance_paginas', null
  ) into v_cobertura;

  return jsonb_build_object(
    'ok', true,
    'gerado_em', now(),
    'atualizacao', v_atualizacao,
    'estado', v_estado_painel,
    'sync', jsonb_build_object(
      'ultima_execucao', v_estado.ultima_execucao,
      'atraso_min', v_atraso_min,
      'ultimo_ciclo', v_estado.ultimo_ciclo,
      'ultimo_erro', v_estado.ultimo_erro,
      'chamadas_dia', v_estado.chamadas_dia,
      'dia', v_estado.dia,
      'saldo_api_restam', v_estado.saldo_api_restam,
      'saldo_api_em', v_estado.saldo_api_em,
      'cursor_mensagem', v_estado.cursor_mensagem,
      'piso_pendente', v_estado.piso_pendente,
      'topo_processado', v_estado.topo_processado,
      'detalhe_fila_tamanho', v_estado.detalhe_fila_tamanho,
      'detalhes_pendencias_abertas', v_estado.detalhes_pendencias_abertas,
      'alerta_gestao', v_estado.alerta_gestao,
      'ciclos_desde_atendimentos', v_estado.ciclos_desde_atendimentos
    ),
    'conversas', v_conversas,
    'atendimentos', v_atend,
    'espera', v_espera,
    'cobertura', v_cobertura
  );
end;
$$;

comment on function public.ulbra_painel_gestao() is
  'Agregacoes do espelho da Mensageria para o painel da GESTAO. Le so o Postgres, nunca a ULBRA. Portao interno: usuario_e_gestao(). Devolve contagens e datas; nenhum dado pessoal. RPC GERENCIAL: a futura central do operador tera consulta propria, com autorizacao e recorte por pessoa -- esta funcao NAO e liberada para operador.';

revoke all on function public.ulbra_painel_gestao() from public, anon;
grant execute on function public.ulbra_painel_gestao() to authenticated;

commit;
