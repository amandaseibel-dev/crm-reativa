-- SUSPENSAO SAI DO SALDO COBRAVEL ATIVO, SEM DEIXAR DE SER DIVIDA.
--
-- Pedido da gestao em 08/10/2026: os titulos de aluno com cobranca suspensa
-- "permanecem registrados como divida, mas ficam excluidos do saldo cobravel
-- ativo e dos indicadores de recuperacao enquanto durar a suspensao, sem
-- encerramento definitivo".
--
-- O QUE A VALIDACAO ENCONTROU, medido em producao em 08/10/2026. Metade disso
-- ja era verdade, metade NAO:
--
--   JA EXCLUIAM (por `casos.encerrado_operacional`, que e true em 115 de 115
--   casos de aluno suspenso):
--     * funil_historico_recuperacao -- suspenso e grupo proprio, e sai do
--       `v_ativo` e do `valor_aberto`;
--     * carteira_geral_base;
--     * minha_carteira_resumo.
--
--   NAO EXCLUIAM:
--     * saldo_cobravel_aluno  <- CORRIGIDO AQUI
--     * saude_carteira_panorama, saude_carteira_resumo_impl,
--       carteira_geral_painel, carteira_safra_situacoes,
--       carteira_cobertura_historica, calibragem_saude,
--       somas_dashboard_principal  <- NAO corrigidos; ver "o que fica" abaixo.
--
-- O UNIVERSO: 118 alunos com cobranca suspensa, 186 titulos, R$ 462.909,38.
--
-- COMO A EXCLUSAO E FEITA, e por que NAO escreve em titulo nenhum. O estado de
-- suspensao ja vive no aluno e no caso, e `aluno_bloqueio_administrativo()` ja
-- sabe le-lo -- ele e o portao canonico e devolve 'SUSPENSAO_COBRANCA'. Entao a
-- exclusao e DERIVADA do estado, e nao gravada no titulo. Isso resolve de uma
-- vez as tres exigencias:
--
--   * "permanecem registrados como divida" -- nenhuma linha de
--     `acordos_titulos` e tocada. `situacao` continua ABERTO, o valor continua
--     la, e `aluno_saldo_pendente_detalhe` (que e o saldo REGISTRADO) continua
--     somando. De proposito: ela nao e alterada por esta migration;
--   * "sem encerramento definitivo" -- nao ha o que desfazer, porque nada foi
--     escrito. Nao passa nem perto de `origem_encerramento`, que e terminal;
--   * "possibilidade de reativacao" -- a exclusao cai sozinha quando a
--     suspensao cai. `suspensao_cobranca_reativar` limpa o status do aluno e do
--     caso, o portao deixa de devolver 'SUSPENSAO_COBRANCA', e o saldo volta no
--     mesmo instante. Zero backfill de volta.
--
-- A LINHA ENTRE OS DOIS SALDOS, que esta migration formaliza:
--   aluno_saldo_pendente_detalhe .. divida REGISTRADA  -> suspenso ENTRA
--   saldo_cobravel_aluno .......... divida COBRAVEL    -> suspenso SAI
--
-- O QUE FICA, e precisa de decisao da gestao: os 7 paineis listados acima
-- seguem somando os R$ 462.909,38. Nao foram alterados aqui porque sao paineis
-- de ESTOQUE de carteira, onde mostrar a divida registrada e defensavel, e
-- porque alterar 7 funcoes de agregacao de dinheiro de uma vez -- cada uma com
-- forma propria, sem padrao mecanico seguro -- e o tipo de mudanca que este
-- projeto ja viu derrubar tela por plano de consulta. Elas entram num PR
-- proprio se a gestao quiser.
--
-- ROLLBACK: supabase/rollbacks/20261008103000_suspensao_fora_do_saldo_cobravel.rollback.sql

-- ---------------------------------------------------------------------------
-- saldo_cobravel_aluno -- corpo de PRODUCAO de 08/10/2026 + o portao
-- ---------------------------------------------------------------------------
create or replace function public.saldo_cobravel_aluno(p_aluno_id uuid)
returns numeric
language sql
stable security definer
set search_path to 'public'
as $function$
  SELECT CASE
    -- + 08/10/2026: cobranca suspensa nao tem saldo COBRAVEL. A divida segue
    -- registrada e visivel em `aluno_saldo_pendente_detalhe`; o que sai e a
    -- cobrabilidade, e ela volta sozinha quando a suspensao e levantada.
    --
    -- So SUSPENSAO entra nesta guarda. Cancelamento e juridico sao tratados por
    -- outro caminho (o titulo e encerrado administrativamente), e colocar os
    -- tres aqui esconderia divida que ninguem suspendeu.
    WHEN public.aluno_bloqueio_administrativo(p_aluno_id) = 'SUSPENSAO_COBRANCA'
      THEN 0::numeric
    ELSE round(
      coalesce((
        SELECT sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0))
          FROM public.acordos_titulos t
         WHERE t.aluno_id = p_aluno_id
           AND upper(coalesce(t.situacao,'')) IN ('ABERTO','NEGOCIADO')
           AND coalesce(lower(t.status),'') <> 'quitada'
           AND coalesce(t.tipo_boleto,'') <> 'Acordo'
           AND NOT EXISTS (
             SELECT 1 FROM public.acordo_titulo_vinculo v
               JOIN public.acordos a ON a.id = v.acordo_id
              WHERE v.titulo_id = t.id AND coalesce(v.ativo, true)
                AND upper(coalesce(a.status,'')) NOT IN ('CANCELADO','CANCELADA'))
      ), 0)
      + coalesce((
        SELECT sum(coalesce(p.valor,0))
          FROM public.parcelas p
          JOIN public.acordos a ON a.id = p.acordo_id
         WHERE a.aluno_id = p_aluno_id
           AND upper(coalesce(a.status,'')) = 'ATIVO'
           -- + 08/10/2026: era lista literal; agora a fonte unica, que ja
           -- conhece DEVOLVIDA e SUSPENSA. RENEGOCIADA segue excluida aqui
           -- porque esta funcao sempre a excluiu -- e uma das 2 divergencias
           -- preservadas na fundacao.
           AND public.parcela_viva(p.status)
           AND upper(coalesce(p.status,'')) <> 'RENEGOCIADA'
      ), 0)
    , 2) END;
$function$;

comment on function public.saldo_cobravel_aluno(uuid) is
  'Divida COBRAVEL do aluno. Zero quando a cobranca esta suspensa (portao aluno_bloqueio_administrativo): a divida continua registrada em aluno_saldo_pendente_detalhe, so nao e cobravel enquanto durar a suspensao. Nenhum titulo e alterado -- a exclusao e derivada do estado, logo reversivel sozinha ao levantar a suspensao.';

-- ---------------------------------------------------------------------------
-- ASSEGURACAO
-- ---------------------------------------------------------------------------
do $prova$
declare
  v_aluno uuid;
  v_pendente numeric;
  v_cobravel numeric;
  v_titulos int;
begin
  -- um aluno suspenso que TENHA titulo no saldo, se existir neste banco
  select al.id into v_aluno
    from public.alunos al
   where public.aluno_bloqueio_administrativo(al.id) = 'SUSPENSAO_COBRANCA'
     and exists (select 1 from public.acordos_titulos t
                  where t.aluno_id = al.id
                    and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                    and coalesce(lower(t.status),'') <> 'quitada')
   limit 1;

  if v_aluno is null then
    raise notice 'suspensao/saldo: nenhum aluno suspenso com titulo neste banco; asseguracao de dado pulada.';
    return;
  end if;

  v_cobravel := public.saldo_cobravel_aluno(v_aluno);
  v_pendente := (public.aluno_saldo_pendente_detalhe(v_aluno, null)->>'total')::numeric;

  select count(*) into v_titulos
    from public.acordos_titulos t
   where t.aluno_id = v_aluno
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and t.origem_encerramento is null;

  -- 1. saiu do cobravel
  if v_cobravel <> 0 then
    raise exception 'suspensao/saldo: aluno suspenso % ainda tem saldo cobravel de R$ %.', v_aluno, v_cobravel;
  end if;

  -- 2. CONTINUA registrado como divida -- esta e a metade que nao pode se perder
  if coalesce(v_pendente,0) <= 0 then
    raise exception 'suspensao/saldo: a divida do aluno suspenso % DESAPARECEU do saldo registrado (R$ %). A exclusao tem de ser so da cobrabilidade.', v_aluno, v_pendente;
  end if;

  -- 3. sem encerramento definitivo
  if v_titulos = 0 then
    raise exception 'suspensao/saldo: os titulos do aluno suspenso % foram encerrados. Suspensao nao encerra.', v_aluno;
  end if;

  raise notice 'suspensao/saldo OK -- aluno %: cobravel R$ 0, registrado R$ %, % titulo(s) intactos.',
    v_aluno, v_pendente, v_titulos;
end
$prova$;
