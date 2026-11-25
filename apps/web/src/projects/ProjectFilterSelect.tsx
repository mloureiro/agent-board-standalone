import { Button, Combobox, useCombobox } from '@mantine/core';
import { useId, type ReactNode } from 'react';

import { useProjectFilter } from './project-filter.js';
import { useProjects } from './use-projects.js';

export const ALL_PROJECTS_LABEL = 'All projects';
const ALL_VALUE = '';

export function ProjectFilterSelect(): ReactNode {
  const listId = useId();
  const data = useProjects();
  const { projectId, choose } = useProjectFilter();
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });
  if (data === null) return null;
  const choices = (data.projects ?? []).filter((project) => !project.archived);
  const current = choices.find((project) => project.id === projectId);
  return (
    <Combobox
      store={combobox}
      width={220}
      position="bottom-start"
      onOptionSubmit={(value) => {
        choose(value === ALL_VALUE ? null : value);
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target withAriaAttributes={false}>
        <Button
          variant="default"
          role="combobox"
          aria-label="Project"
          aria-haspopup="listbox"
          aria-expanded={combobox.dropdownOpened}
          aria-controls={listId}
          onClick={() => combobox.toggleDropdown()}
        >
          {current === undefined ? ALL_PROJECTS_LABEL : current.label}
        </Button>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Options id={listId}>
          <Combobox.Option value={ALL_VALUE} active={current === undefined}>
            {ALL_PROJECTS_LABEL}
          </Combobox.Option>
          {choices.map((project) => (
            <Combobox.Option key={project.id} value={project.id} active={project.id === projectId}>
              {project.icon === null ? null : <span aria-hidden="true">{project.icon} </span>}
              {project.label}
            </Combobox.Option>
          ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
