# CLAUDE.md

## Integração Prime/ULBRA

**ANTES DE QUALQUER ALTERAÇÃO, INVESTIGAÇÃO OU IMPLEMENTAÇÃO relacionada ao
Prime/ULBRA:**

1. abrir [`docs/integracoes/README.md`](docs/integracoes/README.md)
2. seguir obrigatoriamente o mapa de fontes de verdade e o catálogo documentado
3. não iniciar nova descoberta antes de verificar o que já está mapeado
4. não usar conversas ou memória como fonte primária
5. tratar `docs/integracoes/` como fonte oficial versionada da integração

## Economia de token

1. priorizar o menor consumo que preserve qualidade, segurança e precisão
2. antes de abrir subagente, varrer arquivo inteiro ou subir de modelo, seguir
   a skill `economia-de-tokens` do plugin ReATIVA One — critério objetivo de
   modelo, esforço e número de agentes
3. subir de modelo ou de esforço exige declarar, em uma linha, qual critério
   acionou
