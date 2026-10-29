-- IDENTIDADE NULA (B): AS CINCO FUNÇÕES RESTANTES
-- =============================================================================
-- Segunda metade da correção iniciada na 20261022170000. Mesmo defeito, mesma
-- técnica, consequência menor -- e por isso em migration separada, para as duas
-- prioritárias não esperarem por estas.
--
-- AS CINCO, e o que cada uma escreve:
--   projecao_reprocessar_importacao(uuid)        -> importacoes, rh, auditoria
--   registrar_decisao_suspeita_duplicidade(...)  -> suspeitas, auditoria
--   projecao_definir_meta(13 args)               -> metas, auditoria
--   projecao_definir_meta(3 args)                -> metas
--   projecao_definir_meta_operador(3 args)       -> metas
-- Nenhuma apaga pagamento nem move atribuição financeira; a pior delas mexe em
-- meta e em acumulado de operador, o que distorce indicador sem mover dinheiro.
--
-- UM CASO FORA DO PADRÃO, e ele muda o efeito desta correção:
-- registrar_decisao_suspeita_duplicidade tem, ANTES da allowlist, uma guarda
-- mais forte:
--     IF coalesce(auth.role(),'') <> 'service_role' THEN
--       IF NOT (public.usuario_e_gestao() AND public.perfil_do_usuario_atual() IS NOT NULL) THEN
--         RAISE EXCEPTION 'Acesso negado: requer gestão autorizada e ativa...' ERRCODE 42501;
-- Ela ISENTA `service_role` DE PROPÓSITO. Então, para usuário logado, essa
-- função já estava protegida pela primeira guarda, independente do furo. Mas
-- para a chave de serviço a primeira guarda é pulada por decisão e a segunda
-- (a allowlist) passava por causa do nulo -- ou seja, a chave de serviço
-- chegava ao corpo.
-- CONSEQUÊNCIA DESTA CORREÇÃO, declarada: ela PASSA A BLOQUEAR a chave de
-- serviço nesta função, fechando um caminho que a isenção deixava aberto.
-- Nada chama essa função como service_role hoje -- conferido: nenhuma das 14
-- Edge Functions com chave de serviço chama qualquer uma das sete, e o único
-- chamador é a tela (src/components/SuspeitasPagamentosDuplicados.jsx), com
-- gestão logada. Ainda assim é mudança de comportamento para `service_role`, e
-- a isenção sugere que alguém a quis -- fica registrado em vez de silencioso.
-- A decisão da gestão foi corrigir: decidir caso de pagamento duplicado sem
-- autor humano é exatamente o que não se quer.
--
-- TAMBÉM REGISTRADO: projecao_definir_meta_operador NÃO TEM NENHUM CHAMADOR no
-- repositório. É alcançável só por estar acessível. Remover ou revogar o
-- EXECUTE dela é decisão da gestão e NÃO entra nesta correção mínima.
--
-- As allowlists são preservadas letra por letra: três e-mails em todas as cinco.
-- Nada de assinatura, privilégio, dado ou regra financeira muda.
--
-- Mesmas TRÊS TRAVAS da 20261022170000: md5 antes = medido, âncora exatamente
-- uma vez (conferido: 1 em cada uma das cinco), md5 depois = previsto pelo
-- próprio banco em leitura. Idempotente.
--
-- ROLLBACK: supabase/rollbacks/20261022170100_identidade_nula_restantes.rollback.sql
begin;

do $$
declare
  r record;
  v_def text;
  v_novo text;
  v_atual text;
  v_corrigidas int := 0;
  v_ja int := 0;
begin
  for r in
    select * from (values
      ('public.projecao_reprocessar_importacao(uuid)',
       '4b3d3e4792f61c7d660d1a3d38f09b58',
       '914d6f1246b3005aedd979f8a9b5af80'),
      ('public.registrar_decisao_suspeita_duplicidade(uuid,text,uuid,uuid,text)',
       '5c91e1545c85a850471e533831e01b1c',
       '3caee080465ea1da3992eac032dfe453'),
      ('public.projecao_definir_meta(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'fa0b6f76caca6a1f3b70b5660c10206a',
       'ecb5a8560012fde8bf6b95335afb2b90'),
      ('public.projecao_definir_meta(text,numeric,numeric)',
       '51f402b6b805c46157ed23e41576a377',
       '0d652f76597fc8115ff9ab03db13f2a2'),
      ('public.projecao_definir_meta_operador(text,text,numeric)',
       '1c06b879be23e360a2b41e24e47993db',
       'e36033aa65cdf4618a2c76b08f4d73ad')
    ) as t(assinatura, md5_antes, md5_depois)
  loop
    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;

    if v_atual is null then
      raise exception 'FUNCAO AUSENTE: %', r.assinatura;
    end if;

    if v_atual = r.md5_depois then
      v_ja := v_ja + 1;
      raise notice 'ja corrigida, nada a fazer: %', r.assinatura;
      continue;
    end if;

    -- TRAVA 1
    if v_atual <> r.md5_antes then
      raise exception
        'CORPO INESPERADO em %: md5(prosrc) e %, esperado %. Producao derivou desde a medicao de 22/10/2026 -- reconferir antes de aplicar.',
        r.assinatura, v_atual, r.md5_antes;
    end if;

    v_def := pg_get_functiondef(r.assinatura::regprocedure);

    -- TRAVA 2
    if (length(v_def) - length(replace(v_def, 'IF v_email NOT IN (', ''))) / length('IF v_email NOT IN (') <> 1 then
      raise exception 'ANCORA NAO UNICA em %', r.assinatura;
    end if;

    v_novo := replace(v_def, 'IF v_email NOT IN (', 'IF v_email IS NULL OR v_email NOT IN (');
    execute v_novo;

    -- TRAVA 3
    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;
    if v_atual <> r.md5_depois then
      raise exception
        'RESULTADO INESPERADO em %: md5(prosrc) ficou %, previsto %',
        r.assinatura, v_atual, r.md5_depois;
    end if;

    v_corrigidas := v_corrigidas + 1;
    raise notice 'corrigida: % (md5 % -> %)', r.assinatura, r.md5_antes, r.md5_depois;
  end loop;

  raise notice 'restantes: % corrigida(s), % ja estava(m)', v_corrigidas, v_ja;
end $$;

commit;
