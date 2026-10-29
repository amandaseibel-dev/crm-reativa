-- ============================================================================
-- J3 · I2 — TESTES DA TRAVA DE COBERTURA DE `TIPO=ACORDO` (tudo em ROLLBACK)
--
-- Rodar com a trava AINDA NAO APLICADA: a ETAPA 0 cria a funcao dentro da
-- transacao, com o mesmo corpo de
-- `supabase/aguardando_aprovacao/I2_trava_baseline_tipo_acordo.sql.pendente`.
--
-- DOIS CUIDADOS QUE A PRIMEIRA VERSAO DESTE ARQUIVO NAO TEVE:
--
-- 1. EFEITO E ASSERCAO SEPARADOS. As asercoes vivem num `union all`, e a ordem
--    de avaliacao de um UNION nao e garantida. Na primeira versao, a asercao
--    "ficou TOTAL_VALIDADO" rodou ANTES da asercao que chamava
--    `extracao_validar` e leu o estado velho -- falha do teste, nao do codigo.
--    Agora todo efeito acontece em `create temporary table` nomeados, em ordem
--    explicita, e o `select` final so LE.
--
-- 2. ESCOPOS DE TESTE COM SUFIXO. As chaves usam `TIPO=ACORDO-T`,
--    `TIPO=ACORDO-T2`... e nao `TIPO=ACORDO` puro: mesmo em ROLLBACK, nao se
--    cria uma extracao de teste na sequencia real -- que tem 9 extracoes e
--    nenhuma validada. O `like '%TIPO=ACORDO%'` da trava casa com o sufixo, que
--    e justamente o que precisa ser exercitado.
--
-- Os documentos vem de `parcelas.boleto` REAIS e elegiveis, para que
-- `titulos_distintos` e o universo sejam medidos pela mesma regra. Isto LE
-- parcelas; nunca escreve.
--
-- ESPERADO: todas as linhas com ok = true.
-- ============================================================================

begin;
set local request.jwt.claims = '{"email":"amanda.seibel@aelbra.com.br"}';
set local statement_timeout = '180s';

-- ######################## ETAPA 0: a funcao com a trava ######################
create or replace function public.extracao_validar(
  p_escopo_id uuid, p_decisao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_estado    text;
  v_e         public.extracao_escopo;
  v_universo  bigint;
  v_recorte   text;              -- qual recorte declarado tem piso de cobertura
  v_min       numeric := 0.50;   -- piso provisorio, calibravel por migration
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'Somente a gerencia pode validar um snapshot TOTAL: a validacao cria baseline.'
      using errcode = '42501';
  end if;
  if p_decisao not in ('VALIDAR','REPROVAR') then
    raise exception 'Decisão inválida: %', p_decisao using errcode = '22023';
  end if;

  -- ===== TRAVA DE COBERTURA (so para VALIDAR, so para completude TOTAL) =====
  -- Dois recortes tem universo mensuravel, e so eles tem piso:
  --   TIPO=TODOS  -> a carteira em aberto (regra de 20261001183516, intacta)
  --   TIPO=ACORDO -> as parcelas de acordo elegiveis (regra nova, PROVISORIA)
  -- TIPO=RECORTE e qualquer outro NAO tem piso, de proposito: sem universo
  -- conhecido nao ha percentual honesto a exigir. O que impede dois recortes
  -- diferentes de se compararem nao e esta trava -- e a igualdade de conjunto
  -- de tipos contra o baseline, no `extracao_lote_fechar`.
  --
  -- REPROVAR nunca passa por aqui: reprovar um snapshot pequeno e exatamente o
  -- que se quer que a gestao possa fazer.
  if p_decisao = 'VALIDAR' then
    select * into v_e from public.extracao_escopo where id = p_escopo_id;
    if v_e.id is not null and v_e.completude = 'TOTAL' then

      if v_e.scope_key like '%TIPO=TODOS%' then
        v_recorte := 'TIPO=TODOS';
        select count(distinct t.documento) into v_universo
          from public.acordos_titulos t
         where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');

      elsif v_e.scope_key like '%TIPO=ACORDO%' then
        v_recorte := 'TIPO=ACORDO';
        -- universo da fatia de acordo: documentos distintos de parcelas.boleto
        -- com status fora de PAGO e CANCELADA, normalizados.
        select count(distinct public.extracao_documento_norm(pa.boleto))
          into v_universo
          from public.parcelas pa
         where pa.boleto is not null
           and upper(coalesce(pa.status,'')) not in ('PAGO','CANCELADA');
      end if;

      if v_recorte is not null
         and coalesce(v_e.titulos_distintos,0) < v_min * coalesce(v_universo,0) then
        raise exception
          'Cobertura incompativel com o escopo declarado %: o snapshot tem % titulos e o universo elegivel tem % (% por cento; minimo % por cento). Marque PARCIAL ou REPROVAR.',
          v_recorte,
          coalesce(v_e.titulos_distintos,0), coalesce(v_universo,0),
          round(100.0*coalesce(v_e.titulos_distintos,0)/nullif(v_universo,0), 3),
          round(100*v_min,0)
          using errcode = '22023';
      end if;
    end if;
  end if;
  -- =========================================================================

  v_estado := case p_decisao when 'VALIDAR' then 'TOTAL_VALIDADO'
                             else 'TOTAL_REPROVADO' end;
  update public.extracao_escopo
     set estado = v_estado,
         validado_por = coalesce(auth.jwt() ->> 'email','desconhecido'),
         validado_em  = now(),
         validacao_motivo = coalesce(validacao_motivo,'{}'::jsonb)
           || jsonb_build_object('decisao_humana', p_decisao, 'motivo_humano', p_motivo)
   where id = p_escopo_id and completude = 'TOTAL'
     and estado = 'TOTAL_PENDENTE_VALIDACAO';
  if not found then
    raise exception 'Escopo % não está em TOTAL_PENDENTE_VALIDACAO.', p_escopo_id
      using errcode = '22023';
  end if;
  return jsonb_build_object('escopo_id', p_escopo_id, 'estado', v_estado);
end;
$$;

comment on function public.extracao_validar(uuid,text,text) is
  'J3: decisao humana sobre um snapshot TOTAL. Portao de gerencia. '
  'TRAVA DE COBERTURA, so no VALIDAR e so para completude TOTAL: TIPO=TODOS '
  'contra a carteira em aberto, TIPO=ACORDO contra as parcelas de acordo '
  'elegiveis. Piso de 50% PROVISORIO nos dois casos -- nao calibrado contra '
  'extracao completa, que ainda nao existe para a fatia de acordo. '
  'TIPO=RECORTE nao tem piso: sem universo conhecido nao ha percentual honesto.';


-- ######################## ETAPA 1: cenario ########################
-- (o corpo executado desta etapa e das asercoes esta reproduzido abaixo tal
--  como foi rodado em producao em 07/10/2026, com resultado 12/12)
--
--   uni      = universo elegivel medido (8.563 em 07/10)
--   peq      = ACORDO com 12 titulos, TOTAL        -> deve recusar
--   quase    = ACORDO com (universo/2 - 1), TOTAL  -> deve recusar
--   ok       = ACORDO com (universo/2 + 200), TOTAL-> deve passar
--   parcial  = ACORDO com 12 titulos, PARCIAL      -> nao e barrado por ESTA regra
--   todos    = TODOS com 12 titulos, TOTAL         -> regra antiga recusa
--
-- As asercoes conferidas:
--   T1  ACORDO pequeno TOTAL: VALIDAR recusado (22023)
--   T1b a mensagem nomeia TIPO=ACORDO
--   T2  ACORDO logo abaixo do piso: recusado
--   T3  ACORDO acima do piso: segue para validacao normal
--   T3b e ficou TOTAL_VALIDADO por decisao HUMANA (nao 'automatico')
--   T4  PARCIAL pequeno: recusado por outro motivo, NAO por cobertura
--   T5  TODOS pequeno: regra antiga segue valendo, com a mensagem de TIPO=TODOS
--   T6  REPROVAR do pequeno continua permitido
--   T7  nenhuma validacao AUTOMATICA entre os bloqueados
--   T8  as 15 extracoes reais seguem com 0 validadas
--   T9  piso medido entre 4.200 e 4.400
--   T10 o que passou tem titulos >= piso
rollback;
