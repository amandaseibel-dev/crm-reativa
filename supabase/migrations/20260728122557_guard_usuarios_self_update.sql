-- security(usuarios): guard por coluna contra escalonamento de privilegio na propria conta
--
-- Contexto: a policy PERMISSIVE usuarios_self_update permite UPDATE da propria linha
-- (lower(email)=lower(auth.email())) mas RLS controla LINHAS, nao COLUNAS. Sem guard,
-- o proprio usuario pode escalar privilegio alterando perfil/ativo/permissoes na sua linha.
--
-- Este guard (BEFORE UPDATE) usa WHITELIST: o usuario comum so pode gravar as colunas
-- pessoais legitimas efetivamente usadas pelo frontend (MeuPerfil.jsx e RedefinirSenha.jsx):
--   apelido, foto_path, foto_url, aniversario, deve_trocar_senha
-- QUALQUER outra coluna alterada (null-safe) por usuario comum falha com 42501. A whitelist
-- cobre automaticamente perfil, ativo, email, operador, operador_nome, receptivo, turno,
-- id, created_at, TODAS as colunas pode_* (atuais e futuras) e quaisquer colunas novas,
-- sem precisar enumera-las.
--
-- Autorizacao decidida SOMENTE por identidade verificada do servidor (auth.jwt()->>'email')
-- e lista fixa de gestao — nunca por valores enviados pelo cliente (NEW).
-- Bypass de servidor apenas quando o JWT comprova o contexto:
--   * sem JWT (auth.jwt() IS NULL) => processo interno (postgres/cron/migration);
--   * role=service_role no JWT => backend com service key.
-- NUNCA usar current_user como prova de role: sob SECURITY DEFINER ele viraria o dono
-- (postgres) e o bypass dispararia sempre; por isso a funcao e SECURITY INVOKER e a decisao
-- vem exclusivamente do JWT. SET search_path fixo.
-- Gestao (Amanda / Fernanda) mantem as acoes ja autorizadas (usuarios_gestao_update).
-- Nao altera SELECT, INSERT, DELETE, policies, grants nem outras migrations.

CREATE OR REPLACE FUNCTION public.fn_guard_usuarios_self_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  v_actor      text;
  v_is_gestao  boolean;
  v_new        jsonb;
  v_old        jsonb;
  v_col        text;
  v_violadas   text[] := ARRAY[]::text[];
  -- Colunas pessoais que o proprio usuario comum pode alterar na propria linha.
  v_permitidas constant text[] := ARRAY[
    'apelido',
    'foto_path',
    'foto_url',
    'aniversario',
    'deve_trocar_senha'
  ];
BEGIN
  -- Bypass de contexto de servidor comprovado pelo JWT verificado (nunca current_user):
  --   * auth.jwt() IS NULL              => conexao interna (postgres/cron/migration);
  --   * role=service_role no JWT        => backend com service key.
  -- Usuario final autenticado (inclusive gestao) segue para as regras abaixo.
  IF auth.jwt() IS NULL
     OR lower(coalesce(auth.jwt() ->> 'role', '')) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Identidade do ator: somente do JWT verificado, nunca de NEW/OLD.
  v_actor := lower(coalesce(auth.jwt() ->> 'email', ''));

  -- Administracao de usuarios: SOMENTE Amanda e Fernanda (cobranca07 removida).
  v_is_gestao := v_actor = ANY (ARRAY[
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br'
  ]);

  -- Gestao mantem as acoes administrativas ja autorizadas.
  IF v_is_gestao THEN
    RETURN NEW;
  END IF;

  -- Usuario comum: whitelist. Qualquer coluna FORA da lista permitida cujo valor
  -- foi efetivamente alterado (comparacao null-safe via jsonb IS DISTINCT FROM)
  -- e uma violacao.
  v_new := to_jsonb(NEW);
  v_old := to_jsonb(OLD);

  FOR v_col IN
    SELECT key
      FROM jsonb_object_keys(v_new) AS key
     WHERE NOT (key = ANY (v_permitidas))
  LOOP
    IF (v_new -> v_col) IS DISTINCT FROM (v_old -> v_col) THEN
      v_violadas := array_append(v_violadas, v_col);
    END IF;
  END LOOP;

  IF array_length(v_violadas, 1) IS NOT NULL THEN
    -- Auditoria no log do servidor SEM dados pessoais: apenas o ID da linha (uuid)
    -- e os NOMES das colunas protegidas. Nunca loga e-mail/nome/CPF nem valores.
    RAISE LOG 'guard_usuarios_self_update: negado linha=% colunas_protegidas=%',
      OLD.id, v_violadas;
    RAISE EXCEPTION 'Alteracao de coluna protegida nao autorizada: %',
      array_to_string(v_violadas, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_usuarios_guard_self_update ON public.usuarios;
CREATE TRIGGER trg_usuarios_guard_self_update
  BEFORE UPDATE ON public.usuarios
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_usuarios_self_update();
