-- =============================================================================
-- Proteção: no máximo 1 cadastro ATIVO por e-mail em public.usuarios.
-- Evita a recorrência do bug de cadastro duplicado que quebra o .single()/leitura
-- do perfil no login. Índice parcial (só linhas ativas) — não afeta histórico
-- inativo. NÃO APLICAR EM PRODUÇÃO nesta etapa (validar staging + revisar dados
-- de prod antes; prod pode ter duplicidades ativas a reconciliar primeiro).
-- =============================================================================
create unique index if not exists ux_usuarios_email_ativo_unico
  on public.usuarios (lower(email))
  where ativo;
