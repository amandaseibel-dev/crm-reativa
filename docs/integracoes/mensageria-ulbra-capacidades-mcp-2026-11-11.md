# Mensageria ULBRA — diagnóstico das novas capacidades do conector MCP (11/11/2026)

**Método:** leitura dos contratos (nome, descrição e esquema de parâmetros) das ferramentas que o conector expõe nesta sessão. **Nenhuma chamada real, nenhuma mudança de credencial**, nada aplicado. Frente separada: não altera o pacote de 12/11 (#904) nem o head dele.

**O que mudou:** em 04/11 o conector expunha **8 ferramentas, só de leitura**. Hoje expõe **46**: 28 de leitura e **18 que escrevem** na Mensageria (envio de mensagem, templates, campanhas, abertura/transferência de atendimento, kanban, operadores). Os contratos valem para a conexão OAuth desta sessão (a pessoa que autorizou o conector); o que a **credencial de backend** da coleta enxerga só se sabe por `meu_acesso` (1 chamada; pendente de autorização — pode ser lido da resposta que a própria coleta já faz na janela de 12/11, se a função passar a registrar `escopos` e `soLeitura`).

## 1. Inventário (lido dos contratos)

### 1.1 Leitura (28) — "Não altera nada"
| Ferramenta | O que devolve | Observações para o ReATIVA |
| --- | --- | --- |
| `meu_acesso` | pessoa da conexão, perfil, escopos, **limites restantes**, `soLeitura` | única forma de saber escopos e saldo; já usada pela coleta |
| `consultar_cliente` | cliente por telefone/CPF/nome, no escopo; fora: só "existe" e a equipe | usada pela `ulbra-consultar` (1 chamada, multi-chave) |
| `listar_clientes` | clientes do escopo, páginas de 50, filtros | — |
| `conferir_duplicidade` / `listar_duplicados` | até 20 contatos: existe/em atendimento; grupos de duplicados (gestão) | sem telefone/e-mail nas respostas |
| `listar_conversas` | caixa por canal/situação, páginas ≤ 50, **sem filtro de equipe nem de data** (confirmado) | base da coleta; a estimativa de novembro continua válida |
| `ler_conversa` | mensagens de UMA conversa (50 por página, `antesDe`) | histórico completo sob demanda; custo 1 por página |
| **`buscar_nas_conversas`** (nova) | busca de texto nas mensagens do alcance (≤ 50) | útil para localizar comprovante/boleto citado; custo 1 por busca |
| **`ler_notas_internas`** (nova) | notas da ficha e conversa interna entre atendentes de UM cliente | contexto do atendimento; dado interno da ULBRA |
| `listar_atendimentos` | atendimentos do alcance, **`limite ≤ 500`, filtro por `equipe`, `atendente`, `cliente`, `situacao`** | a coleta usa `situacao=waiting, limite 500` sem `equipe`: com `equipe` (id de `listar_equipes`) reduz carga, não chamadas |
| `consultar_atendimento` / **`caminho_do_lead`** | detalhe e histórico de eventos; origem e "por que esta equipe" | rastreio |
| **`minha_fila`** / **`fila_agora`** | fila da própria pessoa; quem está na fila agora (gestão) | "age como a pessoa": com credencial de backend, é a fila DELA |
| `listar_equipes` / `consultar_operador` / `listar_etiquetas` / `listar_templates` | ids e cadastros de apoio | ids necessários às ferramentas de escrita |
| **`painel_gestao`**, **`indicadores_da_equipe`**, **`cursos_e_campus`**, **`captacao_paga`**, **`pessoas_da_captacao_paga`**, **`custo_dos_templates`**, **`relatorios_gerados`** | painéis da gestão da ULBRA (funil, KPIs, kanban, custo de templates, captação) | indicadores de **captação**, não de cobrança; `pessoas_da_captacao_paga` traz nomes (exige `clientes:read`) |
| **`matriculas_prime`**, **`alunos_e_receita`** | matrículas confirmadas no Prime (classificação de origem) e "quanto cada aluno pagou" | **é a leitura da ULBRA sobre o Prime, não a nossa integração Prime**: não substitui `docs/integracoes/prime-*`; comparar, nunca adotar como fonte |
| `acompanhar_campanhas` / `acompanhar_campanhas_email` | situação e resultados de campanhas | — |
| `montar_publico` | **conta** o público de uma campanha (nunca nomes) | — |
| `pedidos_de_ticket_para_decidir` / `meus_pedidos_de_ticket` | pedidos de ticket (leitura com efeito colateral: vence/cancela os expirados, como a tela) | — |

### 1.2 Escrita (18) — todas "como a pessoa" da conexão
| Ferramenta | Efeito | Guardas no contrato | Risco / política ReATIVA |
| --- | --- | --- | --- |
| **`enviar_mensagem_whatsapp`** | texto ou arquivo ao cliente de um atendimento **SEU**, só com janela de 24 h aberta | prévia por padrão; `chave` idempotente; limites por hora; "sai com o nome de quem atende" | **Resposta pelo CRM passa a ser tecnicamente possível** — mas sai em nome da pessoa da credencial. Regra vigente: credencial central **nunca envia**; envio só com conexão individual (OAuth por operador). Fora do pacote. |
| **`enviar_template_whatsapp`** | template aprovado pela Meta ao cliente de atendimento seu (fora da janela de 24 h) | prévia com custo em US$; `chave`; limites por pessoa e por atendimento | custo por mensagem; mesma regra de autoria |
| **`responder_email`** | responde conversa de e-mail | prévia; `chave`; limites por hora | mesma regra de autoria |
| **`abrir_atendimento`** | abre atendimento já aceito para o atendente, cliente da carteira | regras de ticket; `ja_existia` | muda a fila da Mensageria; hoje "oferta e aceite" estão desligados na Central por decisão |
| **`transferir_atendimento`** / **`transferir_em_lote`** (≤ 50 por chamada) | troca atendente/equipe; lote por filtro | prévia; `sem_mudanca`; só gestão para lote | **nunca pela credencial de backend**: transferência automática de carteira é proibida pela regra do piloto |
| **`mover_no_kanban`** | muda coluna; **pode disparar automações que falam com o cliente** | `AUTOMACOES_A_CONFIRMAR` na 1ª chamada; `confirmarAutomacoes` | efeito colateral de envio: tratar como envio |
| **`criar_atendimentos_da_lista`** | até 20 contatos: **cria cliente e atendimento**, inclusive na fila da equipe (`entrega: fila`, escopo `atendimentos:fila`) | prévia; idempotente por lista | **cria cadastro na ULBRA a partir de dados nossos (nome, telefone, e-mail, CPF)** — vedado sem decisão de LGPD/contrato; fora do escopo |
| **`salvar_campanha_whatsapp`** / **`salvar_campanha_email`** / **`anexar_arquivo_email`** / **`excluir_campanha`** | rascunhos de campanha (público até 1.000 ids ou filtros; teto 20.000) | nunca disparam; `chave` | preparação de disparo em massa |
| **`disparar_campanha_whatsapp`** / **`disparar_campanha_email`** | **disparo em massa, com custo, sem volta** (ou agendado) | prévia por padrão; `chave`; limite diário por pessoa; operador ≤ 10 contatos | **proibido pela credencial de backend**; qualquer uso exige decisão da gestão, orçamento e LGPD; sobrepõe-se às ações massivas do ReATIVA (duplicidade de canal) |
| **`ativar_inativar_operador`** / **`editar_operador`** / **`ajustar_inatividade`** | cadastro de operadores e regra de inatividade da equipe (gestão) | prévia na inativação; `sem_mudanca` | administração da ULBRA: fora do ReATIVA |

## 2. O que isto muda (e o que não muda) para o ReATIVA
1. **Nada muda no pacote de 12/11.** `listar_conversas` segue sem filtro de equipe/data; a estimativa (≈ 34 páginas + detalhes, teto 110) permanece. Melhoria barata para depois: `listar_atendimentos` com `equipe` (reduz payload; não muda o número de chamadas).
2. **Histórico completo** (pendência declarada na tela): já era possível com `ler_conversa`; `buscar_nas_conversas` e `ler_notas_internas` ampliam o que a ficha poderia mostrar **sob demanda** (1 chamada por página/busca). Decisão de produto + cota; dado interno da ULBRA (`notas`) pede acordo.
3. **Resposta pelo CRM** passa de "indisponível" para "possível com autoria individual": as três ferramentas de envio só agem em atendimento **da pessoa conectada** e assinam com o nome dela. Com a credencial de backend, toda resposta sairia em nome de uma única pessoa — exatamente o que a regra proíbe. O caminho é **OAuth por operador** (token individual guardado pelo ReATIVA, com prévia + `chave` antes de enviar), que é outra frente: segurança (guarda de tokens), cota (500/dia **por pessoa** — cada operador teria a sua), LGPD e acordo com a TI da ULBRA.
4. **Ferramentas de massa e de administração** (campanhas, criar atendimentos de lista, transferir em lote, operadores): **ficam fora** por política. Risco novo: se a credencial de backend tiver esses escopos, um defeito ou abuso na Edge Function teria alcance de escrita em massa. **Recomendação:** pedir à TI da ULBRA uma credencial **só de leitura** para a coleta (`meu_acesso` informa `soLeitura`), ou confirmar que a atual já é — primeira coisa a registrar na janela de 12/11 (a resposta do `meu_acesso` que a coleta já faz traz os escopos; basta a função gravá-los no estado, mudança pequena para a etapa seguinte).
5. **Prime pela ULBRA** (`matriculas_prime`, `alunos_e_receita`): leitura que a ULBRA faz do Prime — **não é fonte de verdade para o ReATIVA** (a integração Prime oficial continua em `docs/integracoes/prime-*`). Pode servir para conferência cruzada futura, nunca para baixa ou situação.

## 3. Controles que os contratos oferecem e que o ReATIVA deve exigir ao usar escrita
- **Prévia por padrão** em todo envio/disparo/transferência em lote/inativação (`previa: false` só na confirmação).
- **Idempotência por `chave`** em envio, template, e-mail, campanha e disparo (repetir não manda de novo) — compatível com o padrão "chave" que o ReATIVA já usa nas ações massivas.
- **Confirmação explícita de automações** em `mover_no_kanban`.
- **Limites** por hora (envios), por dia (disparos), por pessoa (500/dia), por atendimento (templates).
- **Alcance pela pessoa**: nada sai do escopo da conexão; fora dele a resposta é "não encontrou".

## 4. Próximos passos sugeridos (cada um com autorização própria; nenhum no pacote de 12/11)
1. Registrar escopos e `soLeitura` da credencial de backend (sem chamada extra: gravar a resposta do `meu_acesso` que a coleta já faz) e, se tiver escopos de escrita, pedir à TI uma credencial de leitura.
2. Desenho do envio com autoria: OAuth por operador, guarda de token, prévia + `chave`, auditoria no ReATIVA, cota por pessoa.
3. Histórico sob demanda na Central/ficha com `ler_conversa` (e, se autorizado, `buscar_nas_conversas`), com teto por usuário/dia.
4. `listar_atendimentos` com `equipe` na coleta (redução de payload).
5. Campanhas, criação de atendimentos de lista, transferências em lote e administração de operadores: **manter proibidos** para a credencial de backend; qualquer uso futuro passa por decisão da gestão, orçamento e LGPD.
