-- IDENTIDADE NULA (A): AS DUAS FUNÇÕES QUE MEXEM EM DINHEIRO
-- =============================================================================
-- Mesma classe de defeito já corrigida na 20261022131017, agora nas duas
-- funções cuja consequência é pior.
--
-- O DEFEITO. Ambas guardam a entrada com a allowlist escrita como `NOT IN`:
--   projecao_excluir_importacao:  IF v_email NOT IN (3 e-mails) THEN RAISE
--   projecao_alterar_operador:    IF v_email NOT IN (2 e-mails) THEN RAISE
-- com `v_email text := lower(auth.email())` nas duas. Sem claim de e-mail,
-- `auth.email()` devolve NULL, a comparação é `NULL NOT IN (...)` que avalia
-- para NULL -- e NULL NÃO É TRUE. O `IF` não dispara e a função SEGUE.
--
-- POR QUE ESTAS DUAS PRIMEIRO, pela consequência e não pela probabilidade:
--   * projecao_excluir_importacao faz `DELETE FROM public.pagamentos WHERE
--     importacao_id = ...` -- apaga os pagamentos de uma importação inteira, e
--     depois recalcula `rh_acompanhamento_diario` a partir do que sobrou.
--     Importar lixo é ruído; apagar pagamento é perda.
--   * projecao_alterar_operador faz `UPDATE public.pagamentos` trocando
--     operador_email/operador_nome e marcando operador_ajustado_manualmente --
--     move atribuição financeira, que é ranking e comissão.
--
-- ALCANCE MEDIDO EM 22/10/2026, em leitura, sem executar nenhuma das duas:
--   * ACL das duas: authenticated, postgres, service_role. NENHUMA com `anon`
--     nem PUBLIC -- não é visitante anônimo.
--   * auth.users tem 14 usuários e TODOS têm e-mail: 0 anônimos, 0 só-telefone,
--     0 SSO. Então hoje NENHUM usuário logado existente alcança o furo.
--   * Das 14 Edge Functions que usam a chave de serviço, NENHUMA chama
--     qualquer uma das duas. Nenhum cron chama.
-- Conclusão honesta: não é incêndio, é porta destrancada. O caminho real é a
-- CHAVE DE SERVIÇO, por qualquer via que ela tenha vazado ou venha a vazar. O
-- segundo caminho é futuro: habilitar login anônimo ou por telefone criaria
-- sessão `authenticated` sem e-mail, e isso é mudança de CONFIGURAÇÃO, não de
-- código -- ninguém lembraria desta guarda ao fazê-la.
--
-- O QUE MUDA: uma condição em cada função, e nada mais.
--   IF v_email IS NULL OR v_email NOT IN (... a MESMA lista ...)
--
-- AS ALLOWLISTS SÃO PRESERVADAS LETRA POR LETRA, e a diferença entre elas é
-- DELIBERADA: projecao_alterar_operador tem DOIS e-mails (sem cobranca07) e
-- continua com dois. Uniformizar para três concederia um acesso que hoje não
-- existe -- seria ampliar permissão numa correção de segurança.
--
-- NÃO MUDA: corpo fora da condição, assinatura, SECURITY DEFINER, search_path,
-- owner, GRANTs, gatilhos, índices, dados, nem regra financeira.
-- `CREATE OR REPLACE` preserva owner e privilégios.
--
-- COMO MUDA: patch ANCORADO, sem corpo retypado aqui. A migration LÊ a
-- definição viva com `pg_get_functiondef`, troca só o trecho da âncora e
-- executa. Tudo o que não é a âncora vem de produção.
--
-- TRÊS TRAVAS, qualquer uma abortando a transação inteira:
--   1. md5(prosrc) ANTES = o medido, senão RECUSA (produção pode ter derivado);
--   2. âncora EXATAMENTE uma vez -- conferido em leitura: 1 em cada;
--   3. md5(prosrc) DEPOIS = o valor PREVISTO, calculado pelo próprio banco em
--      leitura simulando o `replace`. Verificação contra alvo conhecido.
-- IDEMPOTENTE: se o md5 já é o de depois, registra e segue.
--
-- ROLLBACK: supabase/rollbacks/20261022170000_identidade_nula_prioritarias.rollback.sql
--
-- A OUTRA METADE: as cinco funções restantes vão na 20261022170100, aplicada
-- em seguida e com autorização própria. Separadas de propósito, para estas duas
-- não esperarem pelas outras cinco.
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
      -- assinatura, md5 antes, md5 previsto depois
      ('public.projecao_excluir_importacao(uuid,text)',
       '7306b6dbe648e80a3e2dca17a531236d',
       '8af3ebfb4728dc7cb0c6872845247941'),
      ('public.projecao_alterar_operador(uuid,text,text,text)',
       '373ac04072677eca1e39520872f86fe2',
       'ded13d5b3cfec35ca0e86d26c7854c49')
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

  raise notice 'prioritarias: % corrigida(s), % ja estava(m)', v_corrigidas, v_ja;
end $$;

commit;
