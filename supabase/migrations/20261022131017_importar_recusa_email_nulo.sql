-- IMPORTAÇÃO DA PROJEÇÃO: A ALLOWLIST PASSA A RECUSAR E-MAIL NULO
-- =============================================================================
-- O DEFEITO (medido em 22/10/2026, em produção, só leitura)
--
-- As duas sobrecargas de `projecao_importar_pagamentos` guardam a entrada com
-- uma allowlist de três e-mails, escrita como `NOT IN`:
--
--   7 args:  IF v_email NOT IN ('amanda.seibel@…','cobranca04@…','cobranca07@…')
--   4 args:  IF lower(auth.email()) NOT IN (… os mesmos três …)
--
-- Sem claim de e-mail no token, `auth.email()` devolve NULL -- a definição viva
-- é `coalesce(nullif(current_setting('request.jwt.claim.email',true),''),
-- claims->>'email')`, e ambos os ramos dão NULL. Então a comparação é
-- `NULL NOT IN (...)`, que avalia para **NULL — e NULL não é TRUE**. O `IF` não
-- dispara, a função segue, e a importação ACONTECE: grava em `importacoes`, em
-- `pagamentos`, em `rh_acompanhamento_diario` e em `auditoria`, esta última com
-- `usuario` nulo. Dinheiro entra sem responsável.
--
-- Alcance: `anon` não tem EXECUTE, mas `authenticated` e `service_role` têm, nas
-- DUAS sobrecargas. Quem tem a chave de serviço importa sem passar pela
-- allowlist.
--
-- POR QUE AS DUAS, e não só a que a tela usa: a de 4 argumentos tem o mesmo
-- furo e é pior se alcançada -- insere linha por linha, sem
-- `numero_parcela_completo` e sem nenhuma das travas de duplicidade, com
-- `ON CONFLICT (titulo_numero, data_pagamento)`. Essa chave está errada: duas
-- parcelas do MESMO título são pagamentos distintos (provado em
-- supabase/tests/santander_importar_idempotencia.test.js), então ela colapsaria
-- dois pagamentos em um. Nenhum código do repositório a chama -- é legado vivo
-- apenas por estar acessível. Corrigir só a de 7 argumentos deixaria o furo
-- aberto pela porta pior.
--
-- O QUE MUDA: uma condição em cada função. Nada mais.
--   7 args:  IF v_email IS NULL OR v_email NOT IN (…)
--   4 args:  IF auth.email() IS NULL OR lower(auth.email()) NOT IN (…)
-- A allowlist é preservada LETRA POR LETRA -- os mesmos três e-mails, na mesma
-- ordem. Quem importa hoje continua importando exatamente como hoje; o único
-- comportamento que muda é o do chamador sem e-mail, que passa de "importa" para
-- "recusado" com a mensagem que já existe.
--
-- NÃO MUDA: corpo (fora da condição), assinatura, SECURITY DEFINER,
-- search_path, statement_timeout, owner, GRANTs, gatilhos, índices, regra
-- financeira, conciliação, baixa, projeção, TV, nem os jobs da PR #722.
-- `CREATE OR REPLACE` preserva owner e privilégios.
--
-- COMO MUDA: patch ANCORADO. Não há corpo retypado aqui. A migration LÊ a
-- definição viva com `pg_get_functiondef`, troca só o trecho da âncora e
-- executa o resultado. Tudo o que não é a âncora vem de produção, não de mim --
-- é o que elimina a classe de erro "reescrevi a função e mudei algo sem querer".
--
-- TRÊS TRAVAS, e qualquer uma aborta a transação inteira:
--   1. md5(prosrc) ANTES tem de ser o que foi medido. Se produção derivou desde
--      a medição, a migration RECUSA em vez de aplicar sobre corpo desconhecido.
--   2. a âncora tem de aparecer EXATAMENTE uma vez (conferido: 1 em cada).
--   3. md5(prosrc) DEPOIS tem de ser o valor PREVISTO. A previsão foi calculada
--      em produção, em leitura, simulando o `replace` -- então o resultado é
--      verificado contra um alvo conhecido, não contra "parece certo".
--
-- IDEMPOTENTE: se o md5 já é o de depois, registra e segue sem reaplicar.
--
-- ROLLBACK: supabase/rollbacks/20261022150000_importar_recusa_email_nulo.rollback.sql
-- (faz a troca inversa, com as mesmas três travas na ordem espelhada).
--
-- O QUE ESTA MIGRATION NÃO RESOLVE, e fica registrado: a allowlist continua
-- sendo três e-mails embutidos no corpo de duas funções. Trocar isso por tabela
-- ou por papel é melhoria de verdade, mas é mudança de desenho -- não entra numa
-- correção de segurança mínima.
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
      -- assinatura, md5 antes, md5 previsto depois, âncora, troca
      ('public.projecao_importar_pagamentos(text,text,jsonb,text,boolean,uuid,text)',
       'a0880e5367d19e0a02ef9f71c9447860',
       '1e376707892d12ed66f77479371ece45',
       'IF v_email NOT IN (',
       'IF v_email IS NULL OR v_email NOT IN ('),
      ('public.projecao_importar_pagamentos(text,text,jsonb,boolean)',
       'ea90af29c17787046fcbb61382028f3b',
       '8ba7459a400ee4c489ed4147f3c76e95',
       'IF lower(auth.email()) NOT IN (',
       'IF auth.email() IS NULL OR lower(auth.email()) NOT IN (')
    ) as t(assinatura, md5_antes, md5_depois, ancora, troca)
  loop
    select md5(p.prosrc) into v_atual
      from pg_proc p
     where p.oid = r.assinatura::regprocedure;

    if v_atual is null then
      raise exception 'FUNCAO AUSENTE: %', r.assinatura;
    end if;

    -- Já corrigida: não reaplica.
    if v_atual = r.md5_depois then
      v_ja := v_ja + 1;
      raise notice 'ja corrigida, nada a fazer: %', r.assinatura;
      continue;
    end if;

    -- TRAVA 1: o corpo tem de ser o medido.
    if v_atual <> r.md5_antes then
      raise exception
        'CORPO INESPERADO em %: md5(prosrc) e %, esperado %. Producao derivou desde a medicao de 22/10/2026 -- reconferir o corpo antes de aplicar.',
        r.assinatura, v_atual, r.md5_antes;
    end if;

    v_def := pg_get_functiondef(r.assinatura::regprocedure);

    -- TRAVA 2: a âncora tem de ser única, senão o replace mexeria em mais de um
    -- lugar.
    if (length(v_def) - length(replace(v_def, r.ancora, ''))) / length(r.ancora) <> 1 then
      raise exception 'ANCORA NAO UNICA em % (ancora: %)', r.assinatura, r.ancora;
    end if;

    v_novo := replace(v_def, r.ancora, r.troca);
    execute v_novo;

    -- TRAVA 3: o resultado tem de ser o previsto.
    select md5(p.prosrc) into v_atual
      from pg_proc p
     where p.oid = r.assinatura::regprocedure;
    if v_atual <> r.md5_depois then
      raise exception
        'RESULTADO INESPERADO em %: md5(prosrc) ficou %, previsto %',
        r.assinatura, v_atual, r.md5_depois;
    end if;

    v_corrigidas := v_corrigidas + 1;
    raise notice 'corrigida: % (md5 % -> %)', r.assinatura, r.md5_antes, r.md5_depois;
  end loop;

  raise notice 'allowlist agora recusa e-mail nulo: % corrigida(s), % ja estava(m)', v_corrigidas, v_ja;
end $$;

commit;
