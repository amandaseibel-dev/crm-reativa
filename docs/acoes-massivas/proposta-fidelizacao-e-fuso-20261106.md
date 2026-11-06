# Proposta: fidelização até o 10º dia em todos os filtros + dia de referência em America/Sao_Paulo

**Data:** 06/11/2026
**Projeto consultado:** `ahattpqrjmhkzsmnbdzs` (leitura). **Nada foi aplicado.**
**Status:** proposta técnica para revisão. Não há migration, merge ou deploy.
**Relação com outros trabalhos:** não altera a correção de responsável por caso (PR #832; `v_rc` e `f_outro`). Os trechos aqui são disjuntos dos dele.

## 1. Problema comprovado (leitura)

1. **TODOS e CASO liberam fidelizados.** A fidelização não é filtro do universo; é só a coluna `fidelizacao_ativa`. Em produção, 1.327 alunos disponíveis em TODOS estão dentro do prazo (todos com responsável definido e acionamento nos últimos 10 dias).
2. **Fuso errado na regra do prazo.** `caso_dentro_prazo_fidelizacao` compara com `current_date` (UTC, pois a sessão está em UTC). O universo converte `data_ultimo_acionamento` para data também em UTC. Entre 21h e 24h de Brasília, o dia UTC já é o seguinte:
   - alunos acionados à noite ficam protegidos um dia a mais do que deveriam (ex.: acionado 22h BRT do dia 26 → protegido até o dia 11 BRT; deveria ser liberado no dia 11);
   - alunos acionados no dia 27 às 10h BRT deixam de ser protegidos às 22h BRT do dia 06 (no dia 10 BRT), antes do fim do prazo.
3. **Caminho de envio sem revalidação.** `acoes_massivas_exportar_emails_do_lote` (envio por e-mail a partir de lote de WhatsApp) grava os `aluno_ids` do lote sem revalidar a proteção. O próprio comentário diz: "Nenhuma outra fonte entra aqui".

### Evidência do fuso (leitura)

Fórmula atual × fórmula corrigida, para os mesmos instantes:

| Caso | Esperado | Fórmula atual (UTC) | Corrigida (BRT) |
|---|---|---|---|
| Acionado dia 27 10h BRT, agora dia 06 22h BRT (dia 10 BRT) | protegido | **não** | protegido |
| Acionado dia 26 22h BRT, agora dia 06 10h BRT (dia 11 BRT) | liberado | **protegido** | liberado |
| Acionado dia 27 22h BRT, agora dia 06 23h BRT | protegido | protegido | protegido |
| Sem acionamento | liberado | liberado | liberado |

## 2. Por que a correção é mínima

- **Não altera** `caso_dentro_prazo_fidelizacao`. Ela é usada por outras rotinas (calibragem, nivelamento, redistribuição, teto, risco de perder, liberação de fidelização). Mudar esses consumidores é outra decisão (seção 6).
- **Cria uma função nova**, `acoes_massivas_fidelizacao_protege`, usada só pelas Ações Massivas. Ela é pura (recebe o instante de referência), o que permite testar com horários fixos.
- **Mexe em dois pontos:** o universo (cobre prévia, exportação, registro, drilldown, matriz e cobertura, que já usam o universo) e a exportação por lote de WhatsApp.

## 3. Proposta SQL (NÃO executar sem autorização)

Ordem: (0) guarda de MD5, (1) criação da função, (2) patch do universo, (3) patch da exportação por e-mail, (4) verificações, (5) commit. Qualquer falha desfaz tudo.

### 3.0. Guarda e backup

```sql
BEGIN;

DO $g$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_universo') <> '88ec923f40294febcd4376491102b37d' THEN
    RAISE EXCEPTION 'Universo mudou desde a validação. Abortando.';
  END IF;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_exportar_emails_do_lote') <> '9c4c8486b2436a573c0ba589428c172c' THEN
    RAISE EXCEPTION 'Exportação por e-mail mudou desde a validação. Abortando.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_fidelizacao_protege') THEN
    RAISE EXCEPTION 'Função auxiliar já existe. Abortando.';
  END IF;
END $g$;

CREATE TABLE internal.bkp_acoes_massivas_fidelizacao_20261106 AS
SELECT now() AS salvo_em, p.proname, md5(pg_get_functiondef(p.oid)) AS md5_def, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('acoes_massivas_universo','acoes_massivas_exportar_emails_do_lote');
```

### 3.1. Função auxiliar (pura)

```sql
CREATE FUNCTION public.acoes_massivas_fidelizacao_protege(p_dua timestamptz, p_agora timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $f$
  SELECT p_dua IS NOT NULL
     AND (p_dua AT TIME ZONE 'America/Sao_Paulo')::date + 10 >= (p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
$f$;
```

### 3.2. Universo (âncoras verificadas: 1, 2 e 1 ocorrências)

```sql
SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$u1$           (k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,$u1$,
$u1$           (k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,
           (k.resp is not null and public.acoes_massivas_fidelizacao_protege(k.dua)) as f_fid,$u1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$u2$                when e.f_ret then 'retorno_futuro'
                when e.f_outro then 'outro_responsavel'$u2$,
$u2$                when e.f_ret then 'retorno_futuro'
                when e.f_fid then 'fidelizacao_ativa'
                when e.f_outro then 'outro_responsavel'$u2$, 2);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_universo',
$u3$         (cl.resp is not null and cl.dua is not null and public.caso_dentro_prazo_fidelizacao(cl.dua::date)),$u3$,
$u3$         (cl.resp is not null and public.acoes_massivas_fidelizacao_protege(cl.dua)),$u3$, 1);
```

### 3.3. Exportação por e-mail a partir de lote de WhatsApp (âncoras: 1 cada)

```sql
SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e1$    from (select x.id_txt as aluno_id, x.ord, a.nome, btrim(a.email) as email,
                 public.email_valido_para_acao_massiva(a.email) as tem_email$e1$,
$e1$    from (select x.id_txt as aluno_id, x.ord, a.nome, btrim(a.email) as email,
                 (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento)) as fid,
                 (public.email_valido_para_acao_massiva(a.email) and not (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento))) as tem_email$e1$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e2$   where public.email_valido_para_acao_massiva(a.email);$e2$,
$e2$   where public.email_valido_para_acao_massiva(a.email)
     and not (a.responsavel_atual_email is not null and public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento));$e2$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e3$'aluno_id', d.aluno_id, 'motivo_codigo', 'sem_email_valido',$e3$,
$e3$'aluno_id', d.aluno_id, 'motivo_codigo', case when d.fid then 'fidelizacao_ativa' else 'sem_email_valido' end,$e3$, 1);

SELECT internal.patch_funcao_ancorada('public', 'acoes_massivas_exportar_emails_do_lote',
$e4$'motivo', 'Sem e-mail válido no cadastro')$e4$,
$e4$'motivo', case when d.fid then 'Protegido pela fidelização até o 10º dia' else 'Sem e-mail válido no cadastro' end)$e4$, 1);
```

### 3.4. Verificações (transação aborta em qualquer falha)

```sql
DO $t$
DECLARE v_md5u text; v_md5e text; v_n int; v_dono text;
BEGIN
  -- 4a. MD5 final de cada função (valores calculados em leitura, ver seção 5)
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5u FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='acoes_massivas_universo';
  IF v_md5u <> 'c26ef92f99bef7b03b6333ded77bbebd' THEN RAISE EXCEPTION 'MD5 do universo diferente do validado.'; END IF;
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5e FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='acoes_massivas_exportar_emails_do_lote';
  IF v_md5e <> '00d3370a7800bd334292808e1573a57d' THEN RAISE EXCEPTION 'MD5 da exportação por e-mail diferente do validado.'; END IF;

  -- 4b. Nenhum disponível dentro da proteção, em TODOS
  SELECT count(*) INTO v_n
    FROM public.acoes_massivas_universo('{"operador":"todos","tipo_cobranca":"MENSALIDADES_E_ACORDOS"}'::jsonb) u
    JOIN public.alunos a ON a.id = u.aluno_id
   WHERE u.disponivel AND a.responsavel_atual_email IS NOT NULL
     AND public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento);
  IF v_n <> 0 THEN RAISE EXCEPTION 'TODOS libera % fidelizado(s).', v_n; END IF;

  -- 4c. Nenhum disponível dentro da proteção, em CASO de um responsável real
  SELECT lower(c.operador_email) INTO v_dono FROM public.casos c
   WHERE c.operador_email IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;
  IF v_dono IS NULL THEN RAISE EXCEPTION 'Sem responsável válido para o teste.'; END IF;
  SELECT count(*) INTO v_n
    FROM public.acoes_massivas_universo(jsonb_build_object('operador','caso:'||v_dono,'tipo_cobranca','MENSALIDADES_E_ACORDOS')) u
    JOIN public.alunos a ON a.id = u.aluno_id
   WHERE u.disponivel AND public.acoes_massivas_fidelizacao_protege(a.data_ultimo_acionamento);
  IF v_n <> 0 THEN RAISE EXCEPTION 'CASO libera % fidelizado(s).', v_n; END IF;

  -- 4d. Liberação correta no 11º dia (pela própria função, com horários fixos)
  IF public.acoes_massivas_fidelizacao_protege(timestamptz '2026-10-26 10:00:00-03', timestamptz '2026-11-06 10:00:00-03') THEN
    RAISE EXCEPTION 'Teste 11º dia: deveria estar liberado.';
  END IF;
  IF NOT public.acoes_massivas_fidelizacao_protege(timestamptz '2026-10-27 10:00:00-03', timestamptz '2026-11-06 22:00:00-03') THEN
    RAISE EXCEPTION 'Teste 10º dia à noite: deveria estar protegido.';
  END IF;
  IF public.acoes_massivas_fidelizacao_protege(timestamptz '2026-10-26 22:00:00-03', timestamptz '2026-11-06 10:00:00-03') THEN
    RAISE EXCEPTION 'Teste acionamento à noite: deveria estar liberado no 11º dia BRT.';
  END IF;
END $t$;

COMMIT;
```

## 4. Rollback protegido (NÃO executar sem autorização)

Só restaura se as funções ainda tiverem o MD5 proposto; se houver alteração posterior, aborta sem tocar.

```sql
BEGIN;
DO $r$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM internal.bkp_acoes_massivas_fidelizacao_20261106 LOOP
    IF md5(r.def) NOT IN ('88ec923f40294febcd4376491102b37d','9c4c8486b2436a573c0ba589428c172c') THEN
      RAISE EXCEPTION 'Backup de % corrompido.', r.proname;
    END IF;
  END LOOP;
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_universo') <> 'c26ef92f99bef7b03b6333ded77bbebd'
  OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='acoes_massivas_exportar_emails_do_lote') <> '00d3370a7800bd334292808e1573a57d' THEN
    RAISE EXCEPTION 'Funções mudaram após a aplicação. Rollback NÃO executado.';
  END IF;
  FOR r IN SELECT * FROM internal.bkp_acoes_massivas_fidelizacao_20261106 LOOP
    EXECUTE r.def;
  END LOOP;
  DROP FUNCTION public.acoes_massivas_fidelizacao_protege(timestamptz, timestamptz);
END $r$;
COMMIT;
```

## 5. MD5 (calculados em leitura, por substituição de texto sobre a definição atual)

| Função | MD5 atual | MD5 proposto | Delta |
|---|---|---|---|
| `acoes_massivas_universo` | `88ec923f40294febcd4376491102b37d` | `c26ef92f99bef7b03b6333ded77bbebd` | +179 caracteres |
| `acoes_massivas_exportar_emails_do_lote` | `9c4c8486b2436a573c0ba589428c172c` | `00d3370a7800bd334292808e1573a57d` | +510 caracteres |

Ressalva: estes MD5 são sobre o texto de produção **sem** a PR #832. Se a #832 for aplicada antes, o MD5 do universo muda e precisa ser recalculado. As âncoras deste patch não se sobrepõem às da #832 (que mexe em `v_op` e em `f_outro`).

## 6. Testes

### 6.1. Função auxiliar (já executada em leitura, com `SELECT` e sem criar nada)

| Caso | Esperado | Obtido |
|---|---|---|
| Dia 10 BRT, de dia | protegido | protegido ✔ |
| Dia 11 BRT, de dia | liberado | liberado ✔ |
| Dia 10 BRT, 22h BRT | protegido | protegido ✔ |
| Acionado 22h BRT dia 26 → dia 11 BRT | liberado | liberado ✔ |
| Acionado 22h BRT dia 27, agora 23h BRT dia 06 | protegido | protegido ✔ |
| Sem acionamento | liberado | liberado ✔ |

### 6.2. Após aplicar (seção 3.4)

- TODOS e CASO: nenhum disponível dentro da proteção.
- Liberação no 11º dia e proteção no 10º dia, com horários fixos.

### 6.3. Testes que dependem de execução (não feitos)

- **Exportação por e-mail:** não há como testar sem gravar lote. Recomenda-se rodar primeiro em **staging**, com um lote de teste, e confirmar que alunos protegidos aparecem em `ids_excluidos` com motivo `fidelizacao_ativa`.
- **Regressão de TODOS e livres:** comparar, antes e depois na mesma transação, que as únicas linhas removidas são fidelizados protegidos (`EXCEPT ALL` nos dois sentidos).
- **Acordos em dia, retornos futuros, pagamentos confirmados e liquidados:** o patch não altera esses motivos (eles vêm antes ou são independentes). Verificar por contagem igual antes e depois.

## 7. Itens que exigem decisão (não incluídos)

1. **Outros consumidores de `caso_dentro_prazo_fidelizacao`** (calibragem, nivelamento, redistribuição de casos, teto de operadores, risco de perder, liberação de fidelização): têm o mesmo problema de fuso. Corrigir todos ampliaria a mudança; recomenda-se tratar em entrega própria.
2. **Motivo novo `fidelizacao_ativa`:** a tela de Ações Massivas precisa de rótulo para ele (arquivo `src/utils/motivosAcaoMassiva.js`). Sem isso, aparece o código cru.
3. **Contador `sem_email` no envio por lote:** passa a incluir também os protegidos. O rótulo do motivo fica correto; o contador agregado não distingue os dois casos.
4. **Responsável inativo (120 disponíveis em TODOS, snapshot de 14:40 UTC):** verificado na tela: `src/pages/BaseReceptiva.jsx` só exibe no receptivo quem não tem responsável ou tem origem receptiva. Os 120 têm responsável preenchido e nenhum tem origem receptiva. Ou seja, **não aparecem no receptivo**, não são redistribuídos e só são alcançados por TODOS. Esta proposta **não** resolve isso; a decisão de redistribuição é da gestão.

## 8. Ordem de autorização

1. Revisão desta proposta e dos testes.
2. Aplicação e verificação **em staging** (confirmar ambiente e projeto antes).
3. Autorização nominal para produção, com projeto, MD5 antes e depois, e escopo: função auxiliar + duas funções de Ações Massivas.
4. Aplicação em produção pelo bloco transacional, com verificações da seção 3.4.

Nenhuma etapa acima foi executada.
